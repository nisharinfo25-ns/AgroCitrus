"""JSON-over-stdio inference worker.

The Next.js server runs this as a short-lived subprocess instead of embedding
Python in the Node process. Reasons:

* TensorFlow never has to be present in the Node runtime image, so the web
  deploy stays small.
* A crashing or segfaulting native library cannot take the web server down.
* One model is loaded per request batch, which is the correct tradeoff for a
  stateless serverless function and is trivially scalable.

Protocol
--------
Request  (stdin)  : ``{"image_path": "...", "bundle_dir": "...", ...}``
Response (stdout) : a single JSON object.
Exit code 0 on success; a non-zero exit code always carries a JSON error body.

Grad-CAM, the processed copy and the overlay are written to ``output_dir`` and
their absolute paths are returned for the caller to upload to Supabase Storage.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..common.errors import CitrusGuardError
from ..common.paths import get_logger
from ..dataset.preprocessor import preprocessed_copy
from ..inference.image_quality import assess_image, enforce
from ..inference.predictor import ModelBundle, predict_image

log = get_logger("inference.worker")


# --------------------------------------------------------------------------- #
# Bundle cache
# --------------------------------------------------------------------------- #
# The one-shot worker loads a fresh `ModelBundle` per process, which is correct
# there. The long-lived server (`server.py`) calls `run` many times in a single
# process, so it must reuse the loaded weights instead of re-reading ~58 MB of
# `.keras` files per image. The cache is keyed by the resolved bundle directory:
# a new deploy is a new directory (client.ts re-verifies the version/checksum
# against Postgres before handing the path over), so a stale cache is impossible.
_BUNDLE_CACHE: dict[str, ModelBundle] = {}


def load_bundle_cached(bundle_dir: str | Path) -> ModelBundle:
    """Load a bundle once per process, or return the already-loaded one."""
    key = str(Path(bundle_dir).resolve())
    bundle = _BUNDLE_CACHE.get(key)
    if bundle is None:
        bundle = ModelBundle.load(key)
        _BUNDLE_CACHE[key] = bundle
    return bundle


def cached_bundle_dirs() -> list[str]:
    return sorted(_BUNDLE_CACHE)


def evict_bundle(bundle_dir: str | Path) -> bool:
    key = str(Path(bundle_dir).resolve())
    return _BUNDLE_CACHE.pop(key, None) is not None


def run(
    request: dict[str, Any], *, bundle: ModelBundle | None = None
) -> dict[str, Any]:
    """Execute one prediction. Raises :class:`CitrusGuardError` on failure.

    ``bundle`` lets a caller that already holds a loaded bundle (the long-lived
    server) skip the cache lookup entirely. When omitted - the one-shot worker
    path - the bundle is loaded from ``bundle_dir`` through the process cache.
    """
    image_path = request.get("image_path")
    bundle_dir = request.get("bundle_dir")
    if not image_path or not bundle_dir:
        raise CitrusGuardError("image_path and bundle_dir are required.", detail=str(request)[:200])

    output_dir = Path(request.get("output_dir") or Path(image_path).parent / "explanation")
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Quality gate runs first: a bad image must never reach the model.
    try:
        quality = assess_image(image_path)
    except CitrusGuardError as exc:
        return {
            "ok": False,
            "stage": "image_quality",
            "error": exc.to_dict(),
        }
    if not quality.passed:
        return {
            "ok": False,
            "stage": "image_quality",
            "quality": quality.to_dict(),
            "error": {
                "code": "image_quality_insufficient",
                "message": (
                    "Image quality is insufficient for reliable analysis. Please "
                    "upload a clearer image."
                ),
                "detail": " ".join(quality.reasons),
            },
        }

    # 2. Persist the processed copy (what the model actually saw).
    bundle = bundle or load_bundle_cached(bundle_dir)
    processed_rel = request.get("processed_name") or "processed.jpg"
    # `preprocessed_copy` takes the size as `size`, not `input_size`:
    # `preprocess_for_inference` (the serving path) uses the `input_size`
    # keyword, and copying that call shape here raised
    # `TypeError: preprocessed_copy() got an unexpected keyword argument
    # 'input_size'` on every single request, so the `processed/` artefact was
    # never written and no prediction ever completed.
    processed_path = preprocessed_copy(
        image_path, output_dir / processed_rel, bundle.input_size
    )

    # 3. Predict + explain. `input_type_hint` is the part the uploader chose
    #    ("leaf"/"fruit") when the automatic router was not trusted; it is
    #    optional and validated inside `predict_image`.
    try:
        result = predict_image(
            image_path,
            bundle,
            quality_report=quality,
            explain_dir=output_dir,
            enable_gradcam=bool(request.get("enable_gradcam", True)),
            part_hint=request.get("input_type_hint"),
        )
    except CitrusGuardError as exc:
        return {
            "ok": False,
            "stage": "prediction",
            "error": exc.to_dict(),
        }

    # Persist the *explanation overlay* next to the processed copy so the caller
    # can upload one coherent `explanation/` prefix per scan.
    explanation_path: str | None = None
    overlay = result.gradcam.get("overlay_path") if result.gradcam else None
    if overlay and Path(overlay).is_file():
        explanation_path = str(output_dir / "overlay.png")
        Path(overlay).replace(explanation_path)

    payload = result.to_dict()
    payload["processed_path"] = str(processed_path)
    if explanation_path:
        if isinstance(payload.get("gradcam"), dict):
            payload["gradcam"]["overlay_path"] = explanation_path
    payload["explanation_path"] = explanation_path
    payload["preprocessing_method"] = bundle.preprocessing_method
    payload["input_size"] = list(bundle.input_size)
    payload["classes_by_part"] = bundle.classes_by_part
    payload["generated_at"] = datetime.now(timezone.utc).isoformat()

    # 4. Stage 1 abstained: no disease head ran and no Grad-CAM exists, so this
    #    is a refusal, not a prediction. The routing measurements are still
    #    returned so the caller can show WHY nothing was diagnosed.
    if payload.get("routing_state") == "uncertain":
        confidence = payload.get("routing_confidence")
        threshold = payload.get("routing_threshold")
        return {
            "ok": False,
            "stage": "routing",
            "quality": quality.to_dict(),
            "result": payload,
            "error": {
                "code": "routing_uncertain",
                "message": payload.get("routing_message")
                or (
                    "Unable to confidently determine whether this is a citrus leaf or "
                    "fruit. Please upload a clearer, closer image of a single citrus "
                    "leaf or fruit."
                ),
                "detail": (
                    f"routing_confidence={confidence} is below "
                    f"min_routing_confidence={threshold}"
                ),
            },
        }

    return {"ok": True, "result": payload}


def _emit(payload: dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, default=str)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="citrusguard-infer",
        description="Single-shot CitrusGuard inference worker (JSON over stdio).",
    )
    parser.add_argument("--request", help="Path to a JSON request file. Reads stdin when omitted.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print the JSON response.")
    args = parser.parse_args(argv)

    try:
        if args.request:
            request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        else:
            raw = sys.stdin.read()
            if not raw.strip():
                _emit(
                    {
                        "ok": False,
                        "error": {
                            "code": "invalid_request",
                            "message": "No request was provided on stdin.",
                        },
                    }
                )
                return 2
            request = json.loads(raw)
    except json.JSONDecodeError as exc:
        _emit(
            {
                "ok": False,
                "error": {
                    "code": "invalid_request",
                    "message": "The request was not valid JSON.",
                    "detail": str(exc),
                },
            }
        )
        return 2

    try:
        response = run(request)
        _emit(response)
        return 0 if response.get("ok") else 1
    except CitrusGuardError as exc:
        log.error("%s: %s", exc.code, exc.message)
        _emit({"ok": False, "stage": request.get("stage", "predict"), "error": exc.to_dict()})
        return 1
    except Exception as exc:  # unexpected: log the traceback server-side only
        log.error("Unhandled inference error: %s\n%s", exc, traceback.format_exc())
        _emit(
            {
                "ok": False,
                "error": {
                    "code": "prediction_failed",
                    "message": "Prediction failed. Please try again.",
                    "detail": str(exc),
                },
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
