"""Supabase Storage + PostgreSQL access for the Python pipeline.

Used by the *offline* setup path (dataset sync, model upload, metadata
upsert). The web app performs the same operations from TypeScript; this module
exists so ``python -m citrusguard supabase ...`` works from a shell or CI
runner.

The service-role key is read from the environment only. It is never written to
disk, never logged and never returned by any function.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..common.errors import StorageError
from ..common.paths import get_logger
from ..config.loader import dataset_config

log = get_logger("storage.supabase")

BUCKETS = {
    "dataset": "citrus-dataset",
    "models": "trained-models",
    "scans": "scan-images",
}


def _require_service_role() -> str:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not key:
        raise StorageError(
            "SUPABASE_SERVICE_ROLE_KEY is not set. Server-side dataset and model "
            "operations require it; it must never be sent to the browser.",
            detail="environment variable missing",
        )
    return key


def _require_url() -> str:
    url = (
        os.getenv("SUPABASE_URL")
        or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        or "https://eczfukabevxcpdbolowm.supabase.co"
    ).strip()
    if not url:
        raise StorageError("SUPABASE_URL is not set.")
    return url


def get_client() -> Any:
    """Return a service-role Supabase client."""
    try:
        from supabase import create_client
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise StorageError(
            "The 'supabase' package is required. Run: pip install -r requirements.txt",
            detail=str(exc),
        ) from exc
    try:
        return create_client(_require_url(), _require_service_role())
    except Exception as exc:
        raise StorageError("Could not connect to Supabase.", detail=str(exc)) from exc


def ensure_buckets(*, public: bool = False) -> dict[str, Any]:
    """Create the three buckets as PRIVATE unless explicitly told otherwise."""
    client = get_client()
    results: dict[str, Any] = {}
    for role, bucket in BUCKETS.items():
        try:
            client.storage.create_bucket(
                bucket,
                options={"public": public, "file_size_limit": None},
            )
            results[bucket] = {"created": True, "role": role, "public": public}
            log.info("Created storage bucket %s", bucket)
        except Exception as exc:
            message = str(exc).lower()
            if "already" in message or "exists" in message:
                results[bucket] = {"created": False, "role": role, "public": public, "note": "already exists"}
            else:
                results[bucket] = {"created": False, "role": role, "error": str(exc)}
                log.error("Could not create bucket %s: %s", bucket, exc)
    return results


def _content_type(path: Path) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".json": "application/json",
        ".keras": "application/octet-stream",
        ".h5": "application/octet-stream",
        ".zip": "application/zip",
        ".csv": "text/csv",
        ".png ": "image/png",
    }.get(path.suffix.lower(), "application/octet-stream")


def upload_file(bucket: str, local_path: Path, remote_path: str) -> dict[str, Any]:
    """Upload a local file, overwriting any previous object at the path."""
    client = get_client()
    local_path = Path(local_path)
    if not local_path.is_file():
        raise StorageError("Cannot upload a file that does not exist.", detail=str(local_path))
    try:
        with local_path.open("rb") as handle:
            client.storage.from_(bucket).upload(
                remote_path,
                handle.read(),
                {"content-type": _content_type(local_path), "upsert": "true"},
            )
    except Exception as exc:
        raise StorageError(
            f"Upload to '{bucket}/{remote_path}' failed.", detail=str(exc)
        ) from exc
    log.info("Uploaded %s -> %s/%s", local_path.name, bucket, remote_path)
    return {"bucket": bucket, "path": remote_path, "bytes": local_path.stat().st_size}


def upload_directory(bucket: str, local_dir: Path, remote_prefix: str, *, pattern: str = "*") -> dict[str, Any]:
    """Recursively upload a directory tree. Returns counts, not file lists."""
    client = get_client()
    local_dir = Path(local_dir)
    if not local_dir.is_dir():
        raise StorageError("Cannot upload a directory that does not exist.", detail=str(local_dir))

    uploaded = 0
    total_bytes = 0
    failures: list[dict[str, str]] = []
    files = [p for p in sorted(local_dir.rglob(pattern)) if p.is_file()]

    for path in files:
        relative = path.relative_to(local_dir).as_posix()
        try:
            result = upload_file(bucket, path, f"{remote_prefix}/{relative}" if remote_prefix else relative)
            uploaded += 1
            total_bytes += int(result["bytes"])
        except StorageError as exc:
            failures.append({"path": relative, "error": exc.message})
    return {
        "bucket": bucket,
        "prefix": remote_prefix,
        "files_total": len(files),
        "files_uploaded": uploaded,
        "bytes_uploaded": total_bytes,
        "failures": failures,
    }


def download_file(bucket: str, remote_path: str, local_path: Path) -> Path:
    client = get_client()
    local_path = Path(local_path)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        payload = client.storage.from_(bucket).download(remote_path)
    except Exception as exc:
        raise StorageError(f"Download of '{bucket}/{remote_path}' failed.", detail=str(exc)) from exc
    if payload is None:
        raise StorageError(f"'{bucket}/{remote_path}' was not found in storage.")
    local_path.write_bytes(bytes(payload))
    return local_path


def list_objects(bucket: str, prefix: str = "", *, limit: int = 1000) -> list[dict[str, Any]]:
    client = get_client()
    try:
        response = client.storage.from_(bucket).list(prefix, limit=limit)
    except Exception as exc:
        raise StorageError(f"Listing '{bucket}/{prefix}' failed.", detail=str(exc)) from exc
    return list(response or [])


def bucket_exists(bucket: str) -> bool:
    try:
        client = get_client()
        client.storage.from_(bucket).list("", limit=1)
        return True
    except StorageError:
        return False
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# PostgreSQL metadata
# --------------------------------------------------------------------------- #
def upsert_dataset_metadata(manifest: dict[str, Any], *, status: str = "ready") -> dict[str, Any]:
    """Mirror the dataset manifest into ``dataset_metadata``."""
    client = get_client()
    row = {
        "dataset_name": manifest["dataset_name"],
        "source_url": manifest["source_url"],
        "landing_page": manifest.get("landing_page"),
        "version": str(manifest["dataset_version"]),
        "license": manifest["license"],
        "license_url": manifest.get("license_url"),
        "doi": manifest.get("doi"),
        "attribution": manifest.get("attribution"),
        "checksum": manifest.get("checksum"),
        "image_count": manifest.get("image_count"),
        "class_count": manifest.get("class_count"),
        "classes": manifest.get("classes", []),
        "parts": manifest.get("parts", []),
        "counts_by_part": manifest.get("counts_by_part", {}),
        "status": status if manifest.get("image_count") is not None else "pending",
        "storage_path": dataset_config().storage_prefix,
        "downloaded_at": manifest.get("downloaded_at"),
        "metadata": {k: v for k, v in manifest.items() if k != "files"},
    }
    rpc_args = {
        "p_dataset_name": row["dataset_name"],
        "p_version": row["version"],
        "p_source_url": row["source_url"],
        "p_landing_page": row["landing_page"],
        "p_license": row["license"],
        "p_license_url": row["license_url"],
        "p_doi": row["doi"],
        "p_attribution": row["attribution"],
        "p_checksum": row["checksum"],
        "p_image_count": row["image_count"],
        "p_class_count": row["class_count"],
        "p_classes": row["classes"],
        "p_parts": row["parts"],
        "p_counts_by_part": row["counts_by_part"],
        "p_storage_path": row["storage_path"],
        "p_downloaded_at": row["downloaded_at"],
        "p_metadata": row["metadata"],
    }
    try:
        result = client.rpc("record_dataset_metadata", rpc_args).execute()
        log.info("Dataset metadata recorded via RPC (%s v%s)", row["dataset_name"], row["version"])
        return (result.data or [row])[0]
    except Exception as exc:
        # The RPC lives in migration 0003. Falling back to a direct upsert keeps
        # an operator who has only applied 0001/0002 working.
        log.warning("record_dataset_metadata RPC unavailable (%s); using a direct upsert", exc)

    try:
        result = (
            client.table("dataset_metadata")
            .upsert(row, on_conflict="dataset_name,version")
            .execute()
        )
    except Exception as exc:
        raise StorageError("Could not write dataset metadata to PostgreSQL.", detail=str(exc)) from exc
    log.info("Dataset metadata upserted (%s v%s)", row["dataset_name"], row["version"])
    return (result.data or [row])[0]


def upsert_model_version(manifest: dict[str, Any], *, status: str = "production") -> dict[str, Any]:
    """Mirror an exported model manifest into ``model_versions``.

Recording and activating are two calls on purpose: the artifact is uploaded
*first*, so the database never points at bytes that are not in Storage yet.
``activate_model_version`` then flips the single-production flag inside one
transaction, so no reader can observe Postgres claiming v2 while Storage still
holds v1.
"""
    client = get_client()
    version = str(manifest["model_version"])

    dataset_row = (
        client.table("dataset_metadata")
        .select("id")
        .eq("dataset_name", manifest["dataset_name"])
        .eq("version", str(manifest["dataset_version"]))
        .limit(1)
        .execute()
    )
    dataset_id = (dataset_row.data or [{}])[0].get("id")

    row = {
        "model_name": manifest["model_name"],
        "version": manifest["model_version"],
        "dataset_id": dataset_id,
        "dataset_version": str(manifest["dataset_version"]),
        "model_architecture": manifest.get("model_architecture"),
        "storage_path": f"versions/{manifest['model_version']}",
        "classes": manifest.get("all_classes", []),
        "classes_by_part": manifest.get("classes_by_part", {}),
        "input_size": manifest.get("input_size"),
        "preprocessing_method": manifest.get("preprocessing_method"),
        "validation_accuracy": manifest.get("validation_accuracy"),
        "test_accuracy": manifest.get("test_accuracy"),
        "model_checksum": manifest.get("model_checksum"),
        "trained_at": manifest.get("trained_at"),
        "part_summary": manifest.get("part_summary", {}),
        "severity_support": manifest.get("severity_support", {"enabled": False}),
        "training_report_path": manifest.get("training_report_path"),
        "notes": manifest.get("notes"),
        "status": status,
    }
    rpc_args = {
        "p_version": row["version"],
        "p_storage_path": row["storage_path"],
        "p_classes": row["classes"],
        "p_classes_by_part": row["classes_by_part"],
        "p_model_checksum": row["model_checksum"],
        "p_validation_accuracy": row["validation_accuracy"],
        "p_test_accuracy": row["test_accuracy"],
        "p_part_summary": row["part_summary"],
        "p_severity_support": row["severity_support"],
        "p_dataset_version": row["dataset_version"],
        "p_model_architecture": row["model_architecture"],
        "p_input_size": row["input_size"],
        "p_preprocessing_method": row["preprocessing_method"],
        "p_training_report_path": row["training_report_path"],
        "p_trained_at": row["trained_at"],
        "p_notes": row["notes"],
    }
    try:
        recorded = (client.rpc("record_model_version", rpc_args).execute().data or [{}])[0]
        if status == "production":
            # Atomic: demotes the incumbent and promotes this row together.
            activated = client.rpc("activate_model_version", {"p_version": version}).execute()
            recorded = (activated.data or [recorded])[0]
        log.info("Model version recorded via RPC (%s %s, status=%s)", row["model_name"], version, status)
        return recorded
    except Exception as exc:
        log.warning("record_model_version RPC unavailable (%s); using a direct upsert", exc)

    try:
        result = (
            client.table("model_versions").upsert(row, on_conflict="model_name,version").execute()
        )
    except Exception as exc:
        raise StorageError("Could not write model metadata to PostgreSQL.", detail=str(exc)) from exc
    log.info("Model version upserted (%s %s)", row["model_name"], row["version"])
    return (result.data or [row])[0]


def sync_dataset(*, include_images: bool = False) -> dict[str, Any]:
    """Upload the prepared dataset to Supabase Storage and record the metadata.

    ``include_images=True`` uploads every image (slow, large). The default
    writes the archive + manifest, which is what the admin dashboard needs to
    prove the dataset is stored persistently in production.
    """
    from ..common.paths import dataset_downloads_dir, dataset_raw_dir
    from ..dataset.validator import read_manifest

    cfg = dataset_config()
    manifest = read_manifest(dataset_raw_dir())
    if not manifest:
        raise StorageError(
            "Dataset setup required. Run `python -m citrusguard dataset download` first.",
            detail=str(dataset_raw_dir()),
        )

    result: dict[str, Any] = {"bucket": cfg.storage_bucket, "prefix": cfg.storage_prefix}

    archive = dataset_downloads_dir() / f"{cfg.name}-v{cfg.version}.zip"
    if archive.is_file():
        result["archive"] = upload_file(cfg.storage_bucket, archive, f"{cfg.storage_prefix}/{archive.name}")

    manifest_path = dataset_raw_dir() / "manifest.json"
    if manifest_path.is_file():
        result["manifest"] = upload_file(
            cfg.storage_bucket, manifest_path, f"{cfg.storage_prefix}/manifest.json"
        )

    if include_images:
        result["images"] = upload_directory(
            cfg.storage_bucket, dataset_raw_dir(), f"{cfg.storage_prefix}/raw", pattern="*.jpg"
        )

    result["metadata"] = upsert_dataset_metadata(manifest, status="ready")
    result["synced_at"] = datetime.now(timezone.utc).isoformat()
    return result


def push_model_bundle(manifest: dict[str, Any], *, promote: bool = True) -> dict[str, Any]:
    """Upload the versioned model bundle and mark it active in PostgreSQL."""
    from ..common.paths import models_root
    from .training.export import production_dir

    version = manifest["model_version"]
    bundle = models_root() / "versions" / version
    if not bundle.is_dir():
        raise StorageError("No exported model bundle to upload.", detail=str(bundle))

    cfg_bucket = "trained-models"
    result: dict[str, Any] = {"bucket": cfg_bucket, "version": version}
    result["upload"] = upload_directory(cfg_bucket, bundle, f"versions/{version}", pattern="*.keras")
    result["config"] = upload_file(
        cfg_bucket, bundle / "config.json", f"versions/{version}/config.json"
    )

    if promote:
        production = production_dir()
        if production.is_dir():
            result["production"] = upload_directory(
                cfg_bucket, production, "production", pattern="*.keras"
            )
            result["production_config"] = upload_file(
                cfg_bucket, production / "config.json", "production/config.json"
            )

    result["metadata"] = upsert_model_version(manifest, status="production" if promote else "candidate")
    return result


def promote_model(version: str) -> dict[str, Any]:
    """Promote a version locally, upload it, and mark it active in the database."""
    from .training.export import load_production_manifest, promote_version

    promote_version(version)
    manifest = load_production_manifest()
    return push_model_bundle(manifest, promote=True)


def storage_status() -> dict[str, Any]:
    """Report bucket availability for the admin System Status panel."""
    out: dict[str, Any] = {"connected": False, "buckets": {}}
    try:
        client = get_client()
        out["connected"] = True
    except StorageError as exc:
        out["error"] = exc.message
        return out

    for role, bucket in BUCKETS.items():
        try:
            objects = client.storage.from_(bucket).list("", limit=1)
            out["buckets"][bucket] = {"role": role, "accessible": objects is not None}
        except Exception as exc:
            out["buckets"][bucket] = {"role": role, "accessible": False, "error": str(exc)}
    return out


def to_json(value: Any) -> str:
    return json.dumps(value, indent=2, default=str)
