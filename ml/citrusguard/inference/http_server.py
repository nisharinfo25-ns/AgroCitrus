"""HTTP wrapper for the CitrusGuard inference pipeline.

Why this exists
---------------
The long-lived `server.py` communicates over JSON-lines/stdio and is designed
for subprocess use inside a local Node.js process.  On Railway (or any
cloud PaaS) the runtime is a container that must expose an HTTP port.

This module wraps the *exact same* ``worker.run`` function with a minimal
FastAPI server so the inference pipeline runs identically in both environments:

  Local   ->  Next.js spawns  `citrusguard.inference.server`  (stdio)
  Railway ->  FastAPI exposes  POST /predict  (HTTP JSON + multipart)

Endpoints
---------
GET  /health           liveness probe; returns {ok, loaded_bundles}
POST /predict          multipart/form-data: image file + JSON fields
                       mirrors the worker.run() request dict
POST /load             pre-warm a bundle: {bundle_dir}
POST /evict            evict a bundle: {bundle_dir}
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Annotated, Any

try:
    from fastapi import FastAPI, File, Form, HTTPException, UploadFile
    from fastapi.responses import JSONResponse
except ImportError as exc:
    raise ImportError(
        "FastAPI is required for the Railway HTTP server. "
        "Install it with: pip install fastapi[standard]"
    ) from exc

from ..common.errors import CitrusGuardError
from ..common.paths import get_logger
from .worker import cached_bundle_dirs, evict_bundle, load_bundle_cached, run

log = get_logger("inference.http_server")

app = FastAPI(title="CitrusGuard Inference", version="1.0.0")

# ---------------------------------------------------------------------------
# The bundle directory is mounted into the container via environment variable.
# The Next.js bridge sends bundle_dir in every request; here it is also read
# from the env at startup so the container can pre-warm on start.
# ---------------------------------------------------------------------------
_BUNDLE_DIR = os.environ.get("CITRUSGUARD_BUNDLE_DIR", "")


@app.on_event("startup")
async def startup() -> None:
    if _BUNDLE_DIR and Path(_BUNDLE_DIR).is_dir():
        log.info("Pre-warming bundle at startup: %s", _BUNDLE_DIR)
        try:
            load_bundle_cached(_BUNDLE_DIR)
            log.info("Bundle warmed successfully")
        except Exception as exc:
            log.warning("Startup warm-up failed (predictions will still work): %s", exc)
    else:
        log.info(
            "CITRUSGUARD_BUNDLE_DIR not set or not a directory (%s). "
            "Models will be loaded on first request.",
            _BUNDLE_DIR or "(empty)",
        )


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "loaded_bundles": cached_bundle_dirs()}


@app.post("/load")
async def load_endpoint(body: dict[str, str]) -> dict[str, Any]:
    bundle_dir = body.get("bundle_dir", "")
    if not bundle_dir:
        raise HTTPException(status_code=400, detail="bundle_dir is required")
    try:
        load_bundle_cached(bundle_dir)
        return {"ok": True, "loaded": True, "bundle_dir": bundle_dir}
    except CitrusGuardError as exc:
        return JSONResponse(status_code=422, content={"ok": False, "error": exc.to_dict()})


@app.post("/evict")
async def evict_endpoint(body: dict[str, str]) -> dict[str, Any]:
    bundle_dir = body.get("bundle_dir", "")
    if not bundle_dir:
        raise HTTPException(status_code=400, detail="bundle_dir is required")
    return {"ok": True, "evicted": evict_bundle(bundle_dir)}


@app.post("/predict")
async def predict_endpoint(
    image: Annotated[UploadFile, File()],
    bundle_dir: Annotated[str, Form()],
    enable_gradcam: Annotated[bool, Form()] = True,
    input_type_hint: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    """Accept a multipart image upload, run the full inference pipeline.

    The image is written to a temporary file so ``worker.run`` can use its
    normal path-based API (OpenCV, PIL, etc.). The temp dir is cleaned up
    after the response is built.
    """
    suffix = Path(image.filename or "input.jpg").suffix or ".jpg"
    with tempfile.TemporaryDirectory(prefix="cg-http-") as tmp_dir:
        tmp_path = Path(tmp_dir) / f"input{suffix}"
        tmp_path.write_bytes(await image.read())

        request: dict[str, Any] = {
            "image_path": str(tmp_path),
            "bundle_dir": bundle_dir,
            "output_dir": tmp_dir,
            "enable_gradcam": enable_gradcam,
        }
        if input_type_hint:
            request["input_type_hint"] = input_type_hint

        try:
            result = run(request)
        except CitrusGuardError as exc:
            return JSONResponse(status_code=422, content={"ok": False, "error": exc.to_dict()})
        except Exception as exc:
            log.exception("Unhandled inference error")
            return JSONResponse(
                status_code=500,
                content={
                    "ok": False,
                    "error": {
                        "code": "prediction_failed",
                        "message": "Prediction failed. Please try again.",
                        "detail": str(exc),
                    },
                },
            )

        # Strip local filesystem paths from the response (the HTTP caller
        # cannot access them and they leak container internals).
        result.pop("gradcam", None)          # heatmap PNGs are local-only
        result.pop("processed_path", None)
        return result


def main() -> None:
    """Entry point for `python -m citrusguard.inference.http_server`."""
    import uvicorn  # type: ignore[import]

    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")
    log.info("Starting CitrusGuard HTTP inference server on %s:%d", host, port)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
