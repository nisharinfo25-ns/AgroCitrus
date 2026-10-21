"""Standalone CitrusGuard ML Inference API service.

Can be deployed on Render, Railway, Fly.io, or run as a local microservice.
The Next.js backend on Vercel communicates with this service via HTTP
when CITRUSGUARD_INFERENCE_URL is configured.
"""

from __future__ import annotations

import base64
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from citrusguard.common.errors import CitrusGuardError
from citrusguard.common.paths import get_logger
from citrusguard.inference.worker import load_bundle_cached, run
from citrusguard.storage.supabase_storage import download_file

log = get_logger("inference.api")

app = FastAPI(title="CitrusGuard ML Inference API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_bundle_dir() -> Path:
    """Find or download the production model bundle."""
    # 1. Check local directory
    root = Path(os.getenv("CITRUSGUARD_PROJECT_ROOT", Path.cwd()))
    local_dir = root / "models" / "production"
    if (local_dir / "config.json").is_file():
        return local_dir

    # 2. Check /tmp cache directory
    cache_dir = Path(tempfile.gettempdir()) / "citrusguard_models" / "production"
    if (cache_dir / "config.json").is_file():
        return cache_dir

    # 3. Download from Supabase Storage
    log.info("Downloading production model bundle from Supabase Storage...")
    cache_dir.mkdir(parents=True, exist_ok=True)
    files = ["config.json", "part_leaf.keras", "part_fruit.keras", "part_router.keras"]
    for filename in files:
        target = cache_dir / filename
        if not target.is_file():
            log.info("Downloading production/%s -> %s", filename, target)
            download_file("trained-models", f"production/{filename}", target)

    return cache_dir


@app.on_event("startup")
def startup_event():
    """Pre-warm model bundle into RAM on startup."""
    try:
        bundle_dir = get_bundle_dir()
        log.info("Pre-warming model bundle from %s...", bundle_dir)
        load_bundle_cached(bundle_dir)
        log.info("Model bundle loaded and warmed successfully.")
    except Exception as exc:
        log.warning("Could not pre-warm model bundle on startup: %s", exc)


@app.get("/")
@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "citrusguard-ml",
        "version": "1.0.0",
    }


class PredictJsonRequest(BaseModel):
    image_base64: str
    enable_gradcam: bool = True
    input_type_hint: Optional[str] = None


def _file_to_base64(path: Optional[str | Path]) -> Optional[str]:
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        return None
    return base64.b64encode(p.read_bytes()).decode("utf-8")


def _execute_prediction(
    image_bytes: bytes,
    enable_gradcam: bool = True,
    input_type_hint: Optional[str] = None,
) -> dict[str, Any]:
    bundle_dir = get_bundle_dir()
    work_dir = Path(tempfile.mkdtemp(prefix="cg_infer_"))
    image_path = work_dir / "input.jpg"
    explain_dir = work_dir / "explanation"

    try:
        image_path.write_bytes(image_bytes)
        request = {
            "image_path": str(image_path),
            "bundle_dir": str(bundle_dir),
            "output_dir": str(explain_dir),
            "processed_name": "processed.png",
            "enable_gradcam": enable_gradcam,
            "input_type_hint": input_type_hint or None,
        }

        response = run(request)

        # Encode generated artifacts as base64
        artifacts: dict[str, Optional[str]] = {
            "processed_base64": None,
            "heatmap_base64": None,
            "overlay_base64": None,
        }

        res = response.get("result") or {}
        if res.get("processed_path"):
            artifacts["processed_base64"] = _file_to_base64(res["processed_path"])
        if res.get("explanation_path"):
            artifacts["overlay_base64"] = _file_to_base64(res["explanation_path"])
        gradcam = res.get("gradcam") or {}
        if gradcam.get("heatmap_path"):
            artifacts["heatmap_base64"] = _file_to_base64(gradcam["heatmap_path"])
        if gradcam.get("overlay_path") and not artifacts["overlay_base64"]:
            artifacts["overlay_base64"] = _file_to_base64(gradcam["overlay_path"])

        response["artifacts"] = artifacts
        return response
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@app.post("/predict")
async def predict_multipart(
    file: UploadFile = File(...),
    enable_gradcam: bool = Form(True),
    input_type_hint: Optional[str] = Form(None),
):
    try:
        content = await file.read()
        return _execute_prediction(
            content,
            enable_gradcam=enable_gradcam,
            input_type_hint=input_type_hint,
        )
    except CitrusGuardError as exc:
        return {"ok": False, "error": exc.to_dict()}
    except Exception as exc:
        log.error("Prediction endpoint error: %s", exc, exc_info=True)
        return {
            "ok": False,
            "error": {
                "code": "prediction_failed",
                "message": f"Inference failed: {str(exc)}",
            },
        }


@app.post("/predict-json")
async def predict_json(req: PredictJsonRequest):
    try:
        content = base64.b64decode(req.image_base64)
        return _execute_prediction(
            content,
            enable_gradcam=req.enable_gradcam,
            input_type_hint=req.input_type_hint,
        )
    except CitrusGuardError as exc:
        return {"ok": False, "error": exc.to_dict()}
    except Exception as exc:
        log.error("Prediction json endpoint error: %s", exc, exc_info=True)
        return {
            "ok": False,
            "error": {
                "code": "prediction_failed",
                "message": f"Inference failed: {str(exc)}",
            },
        }
