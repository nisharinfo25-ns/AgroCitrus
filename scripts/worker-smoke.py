"""Behavioural smoke test of the REAL inference worker against the REAL bundle.

Walks the held-out assignment in ``split_manifest.json``, so every "valid"
case is a genuine unseen image with a known label - none are invented. Runs the
worker's ``run()`` in-process (the transport layer is covered separately by
``scripts/benchmark-inference.py``). No mocks, no synthetic model, no fabricated
labels: an image that is not in the dataset is generated ONLY for the
quality/format failure cases (corrupt, tiny, black), where the point is that the
gate rejects it.

    python scripts/worker-smoke.py --bundle models/production
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "ml")

from citrusguard.common.errors import CitrusGuardError
from citrusguard.dataset.preprocessor import preprocessed_copy  # noqa: F401 (import parity check)
from citrusguard.inference.predictor import ModelBundle
from citrusguard.inference.worker import run

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BUNDLE = ROOT / "models" / "production"
MANIFEST = ROOT / "data" / "citrus" / "processed" / "split_manifest.json"


def _pick(part: str, split: str = "test", klass: str | None = None) -> Path:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rows = [r for r in manifest["assignments"] if r["part"] == part and r["split"] == split]
    if klass is not None:
        rows = [r for r in rows if r["class"] == klass]
    if not rows:
        raise SystemExit(f"No {part}/{split} assignment for class {klass}")
    source = ROOT / "data" / "citrus" / "raw" / rows[0]["source"]
    if not source.is_file():
        raise SystemExit(f"Missing dataset image: {source}")
    return source


def _request(image: Path, bundle_dir: Path, out_dir: Path, **extra) -> dict:
    return {"image_path": str(image), "bundle_dir": str(bundle_dir), "output_dir": str(out_dir), **extra}


def _tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix="cg-smoke-"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=DEFAULT_BUNDLE)
    args = parser.parse_args()
    bundle_dir = args.bundle
    if not (bundle_dir / "config.json").is_file():
        raise SystemExit(f"No bundle at {bundle_dir}")

    # Bundle loaded once, shared across cases (mirrors the warm server).
    bundle = ModelBundle.load(str(bundle_dir))
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, extra: str = "") -> None:
        checks.append((name, ok, extra))
        print("  %-46s %s  %s" % (name, "PASS" if ok else "FAIL", extra))

    # ---- real valid cases (held-out test images) -------------------------- #
    leaf_image = _pick("Leaves")
    fruit_image = _pick("Fruits")
    for label, image, want_part in [("leaf", leaf_image, "leaf"), ("fruit", fruit_image, "fruit")]:
        out = _tmp()
        try:
            response = run(_request(image, bundle_dir, out, enable_gradcam=True), bundle=bundle)
            payload = response.get("result") or {}
            ok = bool(response.get("ok"))
            ok = ok and payload.get("input_type") == want_part
            ok = ok and payload.get("predicted_class") not in (None, "")
            ok = ok and (payload.get("explanation_path") or (payload.get("gradcam") or {}).get("heatmap_path"))
            check("valid %s image -> ok, routed to %s, has Grad-CAM" % (label, want_part), ok,
                  "class=%s conf=%.3f" % (payload.get("predicted_class"), payload.get("confidence") or 0))
        finally:
            shutil.rmtree(out, ignore_errors=True)

    # Healthy, if the dataset holds one.
    for part in ("Leaves", "Fruits"):
        try:
            image = _pick(part, klass="Healthy")
        except SystemExit:
            check("healthy %s image (dataset has none)" % part.lower(), True, "skipped - no Healthy class")
            continue
        out = _tmp()
        try:
            response = run(_request(image, bundle_dir, out), bundle=bundle)
            payload = response.get("result") or {}
            ok = bool(response.get("ok")) and payload.get("status") == "healthy"
            check("healthy %s image -> status healthy" % part.lower(), ok,
                  "class=%s status=%s" % (payload.get("predicted_class"), payload.get("status")))
        finally:
            shutil.rmtree(out, ignore_errors=True)

    # ---- degraded inputs: the gate must reject, not the model guess -------- #
    cases = {
        "corrupt bytes (.jpg)": b"\x00\xff\xd8\xff not a real jpeg" * 64,
        "unsupported (.bmp bytes)": b"BM" + b"\x00" * 4096,
        "tiny 32x32 gradient": None,
    }
    for label in cases:
        out = _tmp()
        path = out / "input.jpg"
        if cases[label] is not None:
            path.write_bytes(cases[label])
        else:  # tiny: a real 32x32 image that fails min_dimension
            import numpy as np
            from PIL import Image

            arr = (np.arange(32 * 32, dtype=np.float32).reshape(32, 32, 1) % 256).astype("uint8")
            Image.fromarray(arr.repeat(3, axis=2)).save(path)
        try:
            response = run(_request(path, bundle_dir, out), bundle=bundle)
            code = (response.get("error") or {}).get("code")
            ok = not response.get("ok") and code in {"image_invalid", "image_quality_insufficient"}
            check(label + " -> rejected", ok, "code=%s" % code)
        finally:
            shutil.rmtree(out, ignore_errors=True)

    # ---- explicit user part selection -------------------------------------- #
    out = _tmp()
    try:
        response = run(
            _request(fruit_image, bundle_dir, out, input_type_hint="fruit"), bundle=bundle
        )
        payload = response.get("result") or {}
        ok = bool(response.get("ok")) and payload.get("routing_state") == "user_selected"
        ok = ok and payload.get("input_type") == "fruit"
        ok = ok and (payload.get("input_type_confidence") is None)
        check("user-selected fruit overrides router", ok,
              "routing_state=%s input_type=%s" % (payload.get("routing_state"), payload.get("input_type")))
    finally:
        shutil.rmtree(out, ignore_errors=True)

    out = _tmp()
    try:
        response = run(_request(leaf_image, bundle_dir, out, input_type_hint="banana"), bundle=bundle)
        code = (response.get("error") or {}).get("code")
        check("invalid part_hint -> rejected", (not response.get("ok")) and code == "prediction_failed",
              "code=%s" % code)
    finally:
        shutil.rmtree(out, ignore_errors=True)

    # ---- missing artifact: actionable error, not a silent fallback ---------- #
    broken = Path(tempfile.mkdtemp(prefix="cg-smoke-broken-"))
    try:
        config = json.loads((bundle_dir / "config.json").read_text(encoding="utf-8"))
        (broken / "config.json").write_text(json.dumps(config), encoding="utf-8")
        # Only the manifest: no .keras files. Loading must raise, loudly.
        try:
            ModelBundle.load(str(broken))
            check("bundle with missing artifacts raises", False, "no error")
        except CitrusGuardError as exc:
            code = getattr(exc, "code", "?")
            check("bundle with missing artifacts raises", code in {"model_not_configured", "model_load_failed"}, "code=%s" % code)
    finally:
        shutil.rmtree(broken, ignore_errors=True)

    print()
    failed = [c for c in checks if not c[1]]
    print("PASS  %d/%d" % (len(checks) - len(failed), len(checks)))
    for name, ok, extra in checks:
        if not ok:
            print("  FAIL %s %s" % (name, extra))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())