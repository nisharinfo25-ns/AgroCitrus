"""Model export, checksum, versioning and promotion.

Export writes a self-describing *bundle*:

    models/versions/<version>/
        config.json          <- classes, sizes, metrics, checksums
        part_leaf.keras
        part_fruit.keras
    models/production/
        <same files>          <- a copy pointing at one specific tested version

``config.json`` is the contract the web app depends on. It carries the class
lists discovered from the dataset, the measured metrics (or ``null`` when a
stage never ran) and the SHA-256 of every artifact, so a corrupted or
swapped model is detected at load time.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..common.errors import ModelNotConfiguredError
from ..common.paths import ensure_dir, get_logger, models_root, reports_root
from ..config.loader import dataset_config, model_config
from .train import ROUTER_PART_KEY, TrainedModel

log = get_logger("training.export")

CONFIG_NAME = "config.json"
_SCHEMA_VERSION = 1


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def _next_version(versions_root: Path) -> str:
    existing: list[int] = []
    if versions_root.is_dir():
        for child in versions_root.iterdir():
            if child.is_dir() and child.name.startswith("v"):
                try:
                    existing.append(int(child.name[1:]))
                except ValueError:
                    continue
    return f"v{max(existing) + 1 if existing else 1}"


def _load_report() -> dict[str, Any]:
    path = reports_root() / "training-report.json"
    if not path.is_file():
        log.warning("No training report found; exported metrics will be null.")
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        log.warning("Training report is not valid JSON; exported metrics will be null.")
        return {}


def export(
    trained: dict[str, TrainedModel],
    *,
    version: str | None = None,
    promote: bool = True,
    notes: str = "",
) -> dict[str, Any]:
    """Write the versioned bundle, then optionally promote it to production."""
    config = model_config()
    dataset = dataset_config()
    report = _load_report()

    versions_root = ensure_dir(models_root() / "versions")
    version = version or _next_version(versions_root)
    bundle_dir = versions_root / version
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    ensure_dir(bundle_dir)

    artifacts: dict[str, str] = {}
    checksums: dict[str, str] = {}
    classes_by_part: dict[str, list[str]] = {}
    part_summary: dict[str, Any] = {}
    training_seconds = 0.0
    routing_summary: dict[str, Any] | None = None

    for part, entry in trained.items():
        filename = f"{entry.part_key}.keras"
        artifact_path = bundle_dir / filename
        entry.model.save(str(artifact_path))
        artifacts[entry.part_key] = filename
        checksums[entry.part_key] = sha256_file(artifact_path)
        training_seconds += entry.training_seconds

        # The stage-1 Leaf-vs-Fruit router is an *identification* model, not a
        # disease model. It ships in `artifacts` (so `ModelBundle` loads it and
        # the storage sync uploads it) but is deliberately kept out of
        # `classes_by_part` and `part_summary`: those two describe the disease
        # label spaces the web app renders, and injecting `leaf`/`fruit` there
        # would make the disease class list wrong.
        if entry.part_key == ROUTER_PART_KEY:
            routing_report = (report.get("routing") or {})
            routing_summary = {
                "artifact": filename,
                "classes": list(entry.classes),
                "architecture": config["model"]["architecture"],
                "input_size": list(config["model"]["input_size"]),
                "preprocessing_method": config["model"].get("preprocessing_method"),
                "min_confidence": float(config.get("routing", {}).get("min_confidence", 0.95)),
                "threshold_selection": routing_report.get("threshold_selection"),
                "training_images": entry.counts.get("train"),
                "validation_images": entry.counts.get("validation"),
                "training_seconds": round(entry.training_seconds, 2),
                "model_parameters": entry.model_params,
                # Only measured values; `None` renders as "Not available".
                "validation_accuracy": (routing_report.get("splits") or {})
                .get("validation", {})
                .get("accuracy"),
                "test_accuracy": (routing_report.get("splits") or {}).get("test", {}).get("accuracy"),
                "test_coverage": (routing_report.get("splits") or {}).get("test", {}).get("coverage"),
                "test_uncertain": (routing_report.get("splits") or {}).get("test", {}).get("uncertain"),
                "splits": routing_report.get("splits"),
                "confusion_matrix_png": routing_report.get("confusion_matrix_png"),
            }
            continue

        classes_by_part[entry.part_key] = list(entry.classes)

        part_report = (report.get("per_part") or {}).get(part, {})
        part_summary[entry.part_key] = {
            "part": part,
            "classes": list(entry.classes),
            "class_count": len(entry.classes),
            "training_images": entry.counts.get("train"),
            "validation_images": entry.counts.get("validation"),
            "test_images": part_report.get("test_images"),
            "training_seconds": round(entry.training_seconds, 2),
            "model_parameters": entry.model_params,
            # Only measured values. `None` renders as "Not available".
            "validation_accuracy": part_report.get("best_validation_accuracy"),
            "test_accuracy": part_report.get("accuracy"),
            "test_macro_f1": part_report.get("macro_f1"),
            "confusion_matrix": part_report.get("confusion_matrix"),
            "per_class": part_report.get("per_class"),
            "confusion_matrix_png": (report.get("artefacts") or {})
            .get(entry.part_key, {})
            .get("confusion_matrix_png"),
            "training_curves_png": (report.get("artefacts") or {})
            .get(entry.part_key, {})
            .get("training_curves_png"),
        }

    # Every entry left in `part_summary` IS a disease head (the router was
    # filtered out above), so the headline disease accuracy is their mean.
    # This used to be `[k for k in part_summary if k != "part_leaf"]`, which
    # dropped the LEAF disease head on the mistaken assumption that `part_leaf`
    # was the part-identification model - leaving the manifest's headline
    # `test_accuracy` as the fruit-only number (0.70) rather than the mean
    # across both disease heads (0.8045).
    disease_heads = list(part_summary)
    test_accuracies = [
        part_summary[k]["test_accuracy"]
        for k in disease_heads
        if part_summary[k].get("test_accuracy") is not None
    ]
    validation_accuracies = [
        part_summary[k]["validation_accuracy"]
        for k in disease_heads
        if part_summary[k].get("validation_accuracy") is not None
    ]

    manifest: dict[str, Any] = {
        "schema_version": _SCHEMA_VERSION,
        "model_name": config["model"]["name"],
        "model_version": version,
        "model_architecture": config["model"]["architecture"],
        "dataset_name": dataset.name,
        "dataset_version": dataset.version,
        "dataset_sha256": (report.get("dataset_sha256") or dataset.sha256 or ""),
        "dataset_source_url": dataset.source_url,
        "dataset_license": dataset.license,
        "input_size": list(config["model"]["input_size"]),
        "preprocessing_method": config["model"].get("preprocessing_method"),
        "classes_by_part": classes_by_part,
        "all_classes": sorted({c for classes in classes_by_part.values() for c in classes}, key=str.lower),
        "artifacts": artifacts,
        "checksums": checksums,
        "model_checksum": _bundle_checksum(checksums),
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_seconds": round(training_seconds, 2),
        "total_test_images": report.get("total_test_images"),
        "dataset_size": report.get("dataset_size"),
        "mean_test_accuracy": report.get("mean_test_accuracy"),
        "test_accuracy": (sum(test_accuracies) / len(test_accuracies)) if test_accuracies else None,
        "validation_accuracy": (
            (sum(validation_accuracies) / len(validation_accuracies))
            if validation_accuracies
            else None
        ),
        "part_summary": part_summary,
        # Stage-1 Leaf-vs-Fruit router. `null` when routing is disabled, in
        # which case the predictor falls back to the legacy heuristic and says
        # so in its `routing_state`.
        "routing": routing_summary,
        "severity_support": config["export"]["severity_support"],
        "min_confidence": config["inference"]["min_confidence"],
        "min_routing_confidence": (
            float(routing_summary["min_confidence"]) if routing_summary else None
        ),
        "image_quality": config["inference"]["image_quality"],
        "notes": notes,
        "status": "candidate",
    }

    config_path = bundle_dir / CONFIG_NAME
    config_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("Exported model bundle %s -> %s", version, bundle_dir)

    if promote:
        promote_version(version, manifest=manifest)
    return manifest


def _bundle_checksum(checksums: dict[str, str]) -> str:
    """Stable digest over the per-head checksums (order-independent)."""
    import hashlib

    digest = hashlib.sha256()
    for key in sorted(checksums):
        digest.update(key.encode())
        digest.update(checksums[key].encode())
    return digest.hexdigest()


def production_dir() -> Path:
    return models_root() / "production"


def promote_version(version: str, *, manifest: dict[str, Any] | None = None) -> Path:
    """Point ``models/production`` at one specific tested version.

    Production is never overwritten blindly: the previous bundle is archived to
    ``models/previous-production/`` first so a bad promotion is reversible.
    """
    source = models_root() / "versions" / version
    if not (source / CONFIG_NAME).is_file():
        raise ModelNotConfiguredError(
            f"Cannot promote '{version}': no exported bundle was found.",
            detail=str(source),
        )

    target = production_dir()
    if target.exists():
        archive = models_root() / "previous-production"
        if archive.exists():
            shutil.rmtree(archive)
        shutil.move(str(target), str(archive))
        log.info("Archived previous production bundle -> %s", archive)

    shutil.copytree(source, target)
    if manifest is not None:
        promoted = dict(manifest)
        promoted["status"] = "production"
        promoted["promoted_at"] = datetime.now(timezone.utc).isoformat()
        promoted["promoted_from"] = str(source)
        (target / CONFIG_NAME).write_text(json.dumps(promoted, indent=2), encoding="utf-8")
    log.info("Promoted model version %s to production", version)
    return target


def load_production_manifest() -> dict[str, Any]:
    path = production_dir() / CONFIG_NAME
    if not path.is_file():
        raise ModelNotConfiguredError(
            "Model is not configured. No production model has been deployed yet.",
            detail=str(path),
        )
    return json.loads(path.read_text(encoding="utf-8"))


def list_versions() -> list[dict[str, Any]]:
    """Every exported version with its status, newest first."""
    versions_root = models_root() / "versions"
    if not versions_root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    production = production_dir()
    active_version = None
    if (production / CONFIG_NAME).is_file():
        try:
            active_version = json.loads((production / CONFIG_NAME).read_text(encoding="utf-8")).get(
                "model_version"
            )
        except json.JSONDecodeError:
            active_version = None

    for child in sorted(versions_root.iterdir(), reverse=True):
        config_path = child / CONFIG_NAME
        if not child.is_dir() or not config_path.is_file():
            continue
        try:
            manifest = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        out.append(
            {
                "version": manifest.get("model_version", child.name),
                "trained_at": manifest.get("trained_at"),
                "status": "production" if manifest.get("model_version") == active_version else "candidate",
                "test_accuracy": manifest.get("test_accuracy"),
                "validation_accuracy": manifest.get("validation_accuracy"),
                "model_checksum": manifest.get("model_checksum"),
                "classes": manifest.get("all_classes", []),
                "notes": manifest.get("notes", ""),
            }
        )
    return out


def verify_integrity(directory: Path | None = None) -> dict[str, Any]:
    """Re-hash the bundle's artifacts and compare against the recorded values."""
    directory = Path(directory or production_dir())
    config_path = directory / CONFIG_NAME
    if not config_path.is_file():
        raise ModelNotConfiguredError("No model bundle found to verify.", detail=str(config_path))
    manifest = json.loads(config_path.read_text(encoding="utf-8"))
    mismatches: list[str] = []
    for key, filename in (manifest.get("artifacts") or {}).items():
        artifact = directory / filename
        if not artifact.is_file():
            mismatches.append(f"{filename} is missing")
            continue
        actual = sha256_file(artifact)
        expected = (manifest.get("checksums") or {}).get(key)
        if expected and actual != expected:
            mismatches.append(f"{filename} checksum mismatch")
    return {
        "healthy": not mismatches,
        "problems": mismatches,
        "model_version": manifest.get("model_version"),
        "model_checksum": manifest.get("model_checksum"),
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }
