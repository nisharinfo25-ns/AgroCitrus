"""CitrusGuard command line interface.

    python -m citrusguard dataset status
    python -m citrusguard dataset download
    python -m citrusguard dataset verify
    python -m citrusguard dataset prepare
    python -m citrusguard model train
    python -m citrusguard model evaluate
    python -m citrusguard model export
    python -m citrusguard model status
    python -m citrusguard supabase provision
    python -m citrusguard supabase sync-dataset
    python -m citrusguard supabase push-model

Every subcommand prints JSON to stdout so the output can be piped into the
Next.js admin API or a CI job. Human-readable logging goes to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .common.errors import CitrusGuardError
from .common.paths import (
    dataset_processed_dir,
    dataset_raw_dir,
    get_logger,
    load_dotenv_if_present,
    reports_root,
)
from .config.loader import dataset_config, model_config

log = get_logger("cli")

BANNER = "CitrusGuard ML pipeline"


def _emit(payload: Any) -> None:
    json.dump(payload, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def _fail(exc: CitrusGuardError) -> int:
    _emit({"ok": False, "error": exc.to_dict()})
    return 1


# --------------------------------------------------------------------------- #
# dataset
# --------------------------------------------------------------------------- #
def cmd_dataset_status(args: argparse.Namespace) -> int:
    from .dataset.validator import manifest_path, read_manifest

    cfg = dataset_config()
    root = dataset_raw_dir()
    manifest = read_manifest(root)
    processed = dataset_processed_dir() / "split_manifest.json"

    # The split manifest is reported alongside the raw manifest because it is
    # what the trainer actually reads - "which images went to which fold" is a
    # question the Dataset Manager has to be able to answer truthfully.
    split: dict[str, Any] | None = None
    if processed.is_file():
        try:
            split = json.loads(processed.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            split = None

    _emit(
        {
            "ok": True,
            "dataset": cfg.to_metadata(),
            "local": {
                "raw_dir": str(root),
                "raw_exists": root.is_dir(),
                "manifest_path": str(manifest_path(root)),
                "manifest_exists": manifest_path(root).is_file(),
                "processed_dir": str(dataset_processed_dir()),
                "split_manifest_exists": processed.is_file(),
            },
            "manifest": manifest
            and {
                k: v
                for k, v in manifest.items()
                if k in {
                    "image_count",
                    "class_count",
                    "classes",
                    "parts",
                    "counts_by_part",
                    "checksum",
                    "downloaded_at",
                    "healthy",
                }
            },
            "split": split,
            "status": "ready" if manifest else "Dataset setup required",
        }
    )
    return 0


def cmd_dataset_download(args: argparse.Namespace) -> int:
    from .dataset.downloader import download_and_extract

    cfg = dataset_config()
    result = download_and_extract(cfg, force=args.force)
    _emit(
        {
            "ok": True,
            "archive": str(result.archive_path),
            "checksum": result.checksum,
            "bytes": result.bytes_downloaded,
            "reused": result.reused,
            "extracted_to": str(result.extracted_path),
            "nested_archives_unwrapped": result.unwrapped,
        }
    )
    return 0


def cmd_dataset_verify(args: argparse.Namespace) -> int:
    from .dataset.validator import read_manifest, verify

    cfg = dataset_config()
    root = dataset_raw_dir()
    if not read_manifest(root):
        raise CitrusGuardError(
            "Dataset setup required. No manifest was found; run the download step first.",
            detail=str(root),
        )
    report = verify(root, cfg)
    _emit({"ok": True, "report": report})
    return 0


def cmd_dataset_prepare(args: argparse.Namespace) -> int:
    from .dataset.downloader import download_and_extract
    from .dataset.splitter import split_dataset
    from .dataset.validator import read_manifest, verify

    cfg = dataset_config()
    model_cfg = model_config()
    if args.download or not read_manifest(dataset_raw_dir()):
        download_and_extract(cfg, force=args.force)

    # The publisher is inconsistent about class-name casing between parts, so
    # folders are canonicalised before the manifest is written. The image count
    # is asserted to be unchanged: normalisation must never lose an image.
    from .dataset.classes import normalise_class_folders
    from .dataset.validator import discover_layout, write_manifest

    raw_root = dataset_raw_dir()
    before = discover_layout(raw_root, cfg).total_images
    if normalise_class_folders(raw_root, cfg):
        layout = discover_layout(raw_root, cfg)
        if layout.total_images != before:
            raise CitrusGuardError(
                "Class-name normalisation changed the image count, which means "
                "the dataset was not re-extracted cleanly. Re-run with --force.",
                detail=f"before={before} after={layout.total_images}",
            )
        write_manifest(raw_root, cfg, layout)

    verify(dataset_raw_dir(), cfg)
    split = split_dataset(
        dataset_raw_dir(), cfg, model_cfg, force=args.force
    )
    _emit(
        {
            "ok": True,
            "processed_dir": split.output_dir,
            "total_images": split.total,
            "parts": split.parts,
            "classes": split.classes,
            "counts": split.counts,
            "seed": split.seed,
        }
    )
    return 0


# --------------------------------------------------------------------------- #
# model
# --------------------------------------------------------------------------- #
def cmd_model_train(args: argparse.Namespace) -> int:
    from .training.train import train_all

    started = __import__("time").perf_counter()
    trained = train_all(
        only_parts=getattr(args, "parts", None),
        resume=bool(getattr(args, "resume", False)),
    )
    _emit(
        {
            "ok": True,
            "trained": {
                part: {
                    "classes": entry.classes,
                    "training_images": entry.counts.get("train"),
                    "training_seconds": entry.training_seconds,
                    "model_parameters": entry.model_params,
                    "best_validation_accuracy": _best(entry, "val_accuracy", "max"),
                }
                for part, entry in trained.items()
            },
            "total_seconds": round(__import__("time").perf_counter() - started, 2),
        }
    )
    return 0


def _best(entry: Any, key: str, mode: str) -> float | None:
    values = [
        v
        for phase in ("phase1", "phase2")
        for v in entry.history.get(f"{phase}_{key}", [])
        if v is not None
    ]
    if not values:
        return None
    return max(values) if mode == "max" else min(values)


def cmd_model_evaluate(args: argparse.Namespace) -> int:
    from .common.paths import models_root
    from .training.evaluate import evaluate
    from .training.train import train_all

    # Evaluation needs the trained objects. Retrain (deterministic seed) so the
    # report always describes a real run rather than a cached guess.
    trained = train_all(
        only_parts=getattr(args, "parts", None),
        resume=bool(getattr(args, "resume", False)),
    )
    report = evaluate(trained)
    _emit({"ok": True, "report": report, "report_path": str(reports_root() / "training-report.json")})
    return 0


def cmd_model_export(args: argparse.Namespace) -> int:
    from .training.evaluate import evaluate
    from .training.export import export
    from .training.train import train_all

    # `--parts` / `--resume` were accepted on this subcommand but never passed on,
    # so `model export --resume` silently retrained everything (~40 min on CPU).
    trained = train_all(
        only_parts=getattr(args, "parts", None),
        resume=bool(getattr(args, "resume", False)),
    )
    report = evaluate(trained)
    # Carry the dataset checksum into the report so the model manifest can
    # reference the exact dataset build it was trained on.
    from .dataset.validator import read_manifest

    manifest = read_manifest(dataset_raw_dir()) or {}
    report["dataset_sha256"] = manifest.get("checksum")

    model_manifest = export(trained, version=args.version, promote=not args.no_promote)
    _emit({"ok": True, "model": model_manifest, "report": str(reports_root() / "training-report.json")})
    return 0


def cmd_model_status(args: argparse.Namespace) -> int:
    from .training.export import list_versions, load_production_manifest, verify_integrity
    from .training.export import production_dir

    try:
        manifest = load_production_manifest()
        integrity = verify_integrity(production_dir())
        status: dict[str, Any] = {"configured": True, "manifest": manifest, "integrity": integrity}
    except CitrusGuardError as exc:
        status = {"configured": False, "reason": exc.message, "manifest": None}

    _emit(
        {
            "ok": True,
            "status": status,
            "versions": list_versions(),
            "production_dir": str(production_dir()),
        }
    )
    return 0


def cmd_model_promote(args: argparse.Namespace) -> int:
    from .training.export import list_versions, promote_version

    promote_version(args.version)
    _emit({"ok": True, "promoted": args.version, "versions": list_versions()})
    return 0


# --------------------------------------------------------------------------- #
# supabase
# --------------------------------------------------------------------------- #
def cmd_supabase_provision(args: argparse.Namespace) -> int:
    from .storage.supabase_storage import ensure_buckets, storage_status

    _emit({"ok": True, "buckets": ensure_buckets(public=False), "status": storage_status()})
    return 0


def cmd_supabase_sync_dataset(args: argparse.Namespace) -> int:
    from .storage.supabase_storage import sync_dataset

    _emit({"ok": True, "result": sync_dataset(include_images=args.include_images)})
    return 0


def cmd_supabase_push_model(args: argparse.Namespace) -> int:
    from .storage.supabase_storage import push_model_bundle
    from .training.export import load_production_manifest

    manifest = load_production_manifest()
    _emit({"ok": True, "result": push_model_bundle(manifest, promote=not args.no_promote)})
    return 0


def cmd_supabase_status(args: argparse.Namespace) -> int:
    from .storage.supabase_storage import storage_status

    _emit({"ok": True, "status": storage_status()})
    return 0


# --------------------------------------------------------------------------- #
# parser
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="citrusguard", description=BANNER)
    sub = parser.add_subparsers(dest="group", required=True)

    dataset = sub.add_parser("dataset", help="Download, validate and split the public dataset.")
    dataset_sub = dataset.add_subparsers(dest="action", required=True)
    dataset_sub.add_parser("status", help="Show dataset status.").set_defaults(func=cmd_dataset_status)
    download = dataset_sub.add_parser("download", help="Download and extract the dataset.")
    download.add_argument("--force", action="store_true", help="Re-download even if present.")
    download.set_defaults(func=cmd_dataset_download)
    dataset_sub.add_parser("verify", help="Validate the prepared dataset.").set_defaults(func=cmd_dataset_verify)
    prepare = dataset_sub.add_parser("prepare", help="Download (if needed), validate and split.")
    prepare.add_argument("--force", action="store_true", help="Force re-download and re-split.")
    prepare.add_argument("--download", action="store_true", help="Force a download first.")
    prepare.set_defaults(func=cmd_dataset_prepare)

    model = sub.add_parser("model", help="Train, evaluate, export and promote models.")
    model_sub = model.add_subparsers(dest="action", required=True)
    train = model_sub.add_parser("train", help="Train every model head.")
    train.set_defaults(func=cmd_model_train)
    evaluate = model_sub.add_parser("evaluate", help="Evaluate on the test split and write the report.")
    evaluate.set_defaults(func=cmd_model_evaluate)
    export = model_sub.add_parser("export", help="Evaluate, export a versioned bundle and promote it.")
    export.add_argument("--version", help="Explicit version label, e.g. v2.")
    for ap_parts in (export, train, evaluate):
        ap_parts.add_argument(
            "--parts",
            nargs="+",
            metavar="PART",
            help=(
                "Train only these parts (e.g. --parts leaves). Matched "
                "case-insensitively against the prepared split."
            ),
        )
        ap_parts.add_argument(
            "--resume",
            action="store_true",
            help=(
                "Reuse an already-trained artefact for any part not named in "
                "--parts instead of retraining it."
            ),
        )

    export.add_argument("--no-promote", action="store_true", help="Do not promote to production.")
    export.set_defaults(func=cmd_model_export)
    model_sub.add_parser("status", help="Show model and production status.").set_defaults(
        func=cmd_model_status
    )
    promote = model_sub.add_parser("promote", help="Promote an exported version to production.")
    promote.add_argument("version")
    promote.set_defaults(func=cmd_model_promote)

    supabase = sub.add_parser("supabase", help="Provision storage and sync artifacts.")
    supabase_sub = supabase.add_subparsers(dest="action", required=True)
    supabase_sub.add_parser("provision", help="Create the three private buckets.").set_defaults(
        func=cmd_supabase_provision
    )
    sync = supabase_sub.add_parser("sync-dataset", help="Upload dataset artifacts + metadata.")
    sync.add_argument("--include-images", action="store_true", help="Also upload every image.")
    sync.set_defaults(func=cmd_supabase_sync_dataset)
    push = supabase_sub.add_parser("push-model", help="Upload the model bundle + metadata.")
    push.add_argument("--no-promote", action="store_true")
    push.set_defaults(func=cmd_supabase_push_model)
    supabase_sub.add_parser("status", help="Report storage connectivity.").set_defaults(
        func=cmd_supabase_status
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    load_dotenv_if_present()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except CitrusGuardError as exc:
        log.error("%s: %s", exc.code, exc.message)
        return _fail(exc)
    except KeyboardInterrupt:  # pragma: no cover
        log.warning("Interrupted.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
