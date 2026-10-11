"""Generate the Supabase SQL that registers the REAL trained model.

Every value emitted here is read at generation time out of a file that was
produced by the pipeline itself:

  * `models/production/config.json`  - the exported bundle manifest
  * `data/citrus/raw/manifest.json`  - the verified dataset manifest
  * `reports/training-report.json`   - the measured evaluation report

Nothing is typed in by hand, so the row cannot drift from the artefacts it
describes, and there is no path by which a placeholder model or an invented
accuracy can enter the database. If a file is missing the script fails loudly
instead of emitting a partial row.

Outputs
-------
`supabase/register_real_model.sql`
    Idempotent seed. Safe to paste as many times as you like: it upserts on the
    real unique keys and demotes any other production row for the same model
    name, so the partial unique index
    `model_versions_single_production_idx` stays satisfied.

`supabase/apply_all.sql`
    `combined_migration.sql` + the seed above, for a single paste into the
    Supabase SQL Editor. The migration half is NOT idempotent (it uses bare
    `create table` / `create type`), so `apply_all.sql` must be run once.

Usage:  python scripts/generate_model_registration.py
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BUNDLE = ROOT / "models" / "production" / "config.json"
DATASET = ROOT / "data" / "citrus" / "raw" / "manifest.json"
REPORT = ROOT / "reports" / "training-report.json"
MIGRATIONS = [
    ROOT / "supabase" / "migrations" / "0001_core_schema.sql",
    ROOT / "supabase" / "migrations" / "0002_reference_content.sql",
    ROOT / "supabase" / "migrations" / "0003_model_activation.sql",
]

OUT_SEED = ROOT / "supabase" / "register_real_model.sql"
OUT_ALL = ROOT / "supabase" / "apply_all.sql"


class GeneratorError(RuntimeError):
    pass


def load_json(path: Path) -> dict:
    if not path.is_file():
        raise GeneratorError(
            "required input is missing: %s\n"
            "This script only registers a model that already exists on disk. "
            "It will not invent one." % path.relative_to(ROOT)
        )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise GeneratorError("%s is not valid JSON: %s" % (path, exc)) from exc


def q(value) -> str:
    """A SQL string literal, or NULL for None."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return "'" + str(value).replace("'", "''") + "'"


def text_array(values) -> str:
    if not values:
        return "array[]::text[]"
    return "array[" + ", ".join(q(v) for v in values) + "]::text[]"


def int_array(values) -> str:
    if not values:
        return "array[]::integer[]"
    return "array[" + ", ".join(str(int(v)) for v in values) + "]::integer[]"


def jsonb(value) -> str:
    return q(json.dumps(value, indent=2, sort_keys=False)) + "::jsonb"


def numeric(value) -> str:
    """Render a float for SQL without inventing precision."""
    if value is None:
        return "null"
    return repr(float(value))


def part_summary(report: dict) -> dict:
    """Per-part measured metrics, keyed the way the app expects."""
    out = {}
    for part, metrics in (report.get("per_part") or {}).items():
        out[part] = {
            "accuracy": metrics.get("accuracy"),
            "macro_precision": metrics.get("macro_precision"),
            "macro_recall": metrics.get("macro_recall"),
            "macro_f1": metrics.get("macro_f1"),
            "weighted_f1": metrics.get("weighted_f1"),
            "test_images": metrics.get("test_images"),
            "per_class": metrics.get("per_class"),
            "confusion_matrix": metrics.get("confusion_matrix"),
            "classes": metrics.get("classes"),
        }
    return out


def main() -> int:
    bundle = load_json(BUNDLE)
    dataset = load_json(DATASET)
    report = load_json(REPORT)

    # ---- refuse to emit a row we cannot fully justify -------------------- #
    required_bundle = [
        "model_name",
        "model_version",
        "model_architecture",
        "classes_by_part",
        "input_size",
        "artifacts",
        "model_checksum",
        "trained_at",
    ]
    missing = [key for key in required_bundle if not bundle.get(key)]
    if missing:
        raise GeneratorError(
            "models/production/config.json is missing %s - refusing to register a "
            "model that cannot be described." % ", ".join(missing)
        )
    if not dataset.get("checksum"):
        raise GeneratorError(
            "data/citrus/raw/manifest.json has no checksum - refusing to register "
            "a dataset whose contents cannot be verified."
        )

    artefacts = {}
    for key, filename in (bundle.get("artifacts") or {}).items():
        artefact = BUNDLE.parent / filename
        if not artefact.is_file():
            raise GeneratorError(
                "the bundle references %s but %s does not exist"
                % (filename, artefact.relative_to(ROOT))
            )
        artefacts[key] = filename

    version = bundle["model_version"]
    storage_path = "versions/%s" % version
    classes_by_part = bundle["classes_by_part"]
    all_classes = bundle.get("all_classes") or sorted(
        {c for part in classes_by_part.values() for c in part}
    )
    image_quality = bundle.get("image_quality") or {}
    severity = bundle.get("severity_support") or {"enabled": False}

    notes = (
        "Registered by scripts/generate_model_registration.py from the exported "
        "bundle at models/production/config.json. Artefacts: %s. Per-part measured "
        "accuracy: %s. Mean test accuracy over %s held-out images: %s."
        % (
            ", ".join("%s=%s" % (k, v) for k, v in sorted(artefacts.items())),
            ", ".join(
                "%s=%s" % (part, (report.get("per_part") or {}).get(part, {}).get("accuracy"))
                for part in sorted((report.get("per_part") or {}))
            ),
            report.get("total_test_images"),
            report.get("mean_test_accuracy"),
        )
    )

    dataset_counts = dataset.get("counts_by_part") or {}
    parts = dataset.get("parts") or []
    dataset_classes = dataset.get("classes") or (
        all_classes if isinstance(all_classes, list) else sorted(all_classes)
    )

    seed = io.StringIO()
    seed.write(
        """-- ==========================================================================
-- CitrusGuard - register the REAL dataset and the REAL trained model
-- ==========================================================================
-- GENERATED FILE - do not hand-edit.
-- Regenerate with:  python scripts/generate_model_registration.py
--
-- Every literal below was read out of:
--   models/production/config.json   (exported bundle manifest)
--   data/citrus/raw/manifest.json   (verified dataset manifest)
--   reports/training-report.json    (measured evaluation report)
--
-- This file is IDEMPOTENT and safe to run repeatedly. It does NOT create
-- tables; apply supabase/combined_migration.sql first (or use
-- supabase/apply_all.sql, which does both in one paste).
--
-- It registers the model that is already trained and verified on disk. It
-- creates no placeholder and asserts no unmeasured accuracy.
-- ==========================================================================

begin;

-- --------------------------------------------------------------------------
-- 1. dataset_metadata - the verified public dataset
-- --------------------------------------------------------------------------
insert into public.dataset_metadata (
  dataset_name, version, source_url, landing_page, license, license_url, doi,
  attribution, checksum, image_count, class_count, classes, parts,
  counts_by_part, status, storage_path, downloaded_at, metadata
) values (
"""
    )
    seed.write("  %s,\n" % q(dataset.get("dataset_name")))
    seed.write("  %s,\n" % q(dataset.get("dataset_version")))
    seed.write("  %s,\n" % q(dataset.get("source_url")))
    seed.write("  %s,\n" % q(dataset.get("landing_page")))
    seed.write("  %s,\n" % q(dataset.get("license")))
    seed.write("  %s,\n" % q(dataset.get("license_url")))
    seed.write("  %s,\n" % q(dataset.get("doi")))
    seed.write("  %s,\n" % q(dataset.get("attribution")))
    seed.write("  %s,\n" % q(dataset.get("checksum")))
    seed.write("  %s,\n" % (dataset.get("image_count") or "null"))
    seed.write("  %s,\n" % (dataset.get("class_count") or "null"))
    seed.write("  %s,\n" % text_array(dataset_classes))
    seed.write("  %s,\n" % text_array(parts))
    seed.write("  %s,\n" % jsonb(dataset_counts))
    seed.write("  'ready',\n")
    seed.write("  %s,\n" % q(dataset.get("source_url")))
    seed.write("  %s,\n" % q(dataset.get("downloaded_at")))
    seed.write(
        "  %s\n"
        % jsonb(
            {
                "manifest_version": dataset.get("manifest_version"),
                "checksum_kind": dataset.get("checksum_kind"),
                "healthy": dataset.get("healthy"),
                "corrupt": dataset.get("corrupt"),
                "unsupported": dataset.get("unsupported"),
                "duplicates": dataset.get("duplicates"),
                "split": {
                    "ratios": json.loads(
                        (ROOT / "data" / "citrus" / "processed" / "split_manifest.json")
                        .read_text(encoding="utf-8")
                    ).get("ratios")
                    if (ROOT / "data" / "citrus" / "processed" / "split_manifest.json").is_file()
                    else None,
                },
            }
        )
    )
    seed.write(
        """)
on conflict (dataset_name, version) do update set
  source_url       = excluded.source_url,
  landing_page     = excluded.landing_page,
  license          = excluded.license,
  license_url      = excluded.license_url,
  doi              = excluded.doi,
  attribution      = excluded.attribution,
  checksum         = excluded.checksum,
  image_count      = excluded.image_count,
  class_count      = excluded.class_count,
  classes          = excluded.classes,
  parts            = excluded.parts,
  counts_by_part   = excluded.counts_by_part,
  status           = excluded.status,
  storage_path     = excluded.storage_path,
  downloaded_at    = excluded.downloaded_at,
  metadata         = excluded.metadata,
  updated_at       = now();

-- --------------------------------------------------------------------------
-- 2. model_versions - the exported bundle, marked production
-- --------------------------------------------------------------------------
-- `model_versions_single_production_idx` allows only ONE production row per
-- model_name, so any previous production row for this model is demoted to
-- 'candidate' first. That is what makes this re-runnable.
update public.model_versions
   set status = 'candidate',
       promoted_at = null,
       updated_at = now()
 where model_name = %s
   and version <> %s
   and status = 'production';

insert into public.model_versions (
  model_name, version, dataset_id, dataset_version, model_architecture,
  storage_path, classes, classes_by_part, input_size, preprocessing_method,
  validation_accuracy, test_accuracy, model_checksum, trained_at, promoted_at,
  part_summary, severity_support, training_report_path, status, notes
) values (
"""
    )
    seed.write("  %s,\n" % q(bundle["model_name"]))
    seed.write("  %s,\n" % q(version))
    seed.write(
        "  (select id from public.dataset_metadata where dataset_name = %s and version = %s),\n"
        % (q(dataset.get("dataset_name")), q(dataset.get("dataset_version")))
    )
    seed.write("  %s,\n" % q(dataset.get("dataset_version")))
    seed.write("  %s,\n" % q(bundle["model_architecture"]))
    seed.write("  %s,\n" % q(storage_path))
    seed.write("  %s,\n" % text_array(all_classes))
    seed.write("  %s,\n" % jsonb(classes_by_part))
    seed.write("  %s,\n" % int_array(bundle["input_size"]))
    seed.write("  %s,\n" % q(bundle.get("preprocessing_method")))
    seed.write("  %s,\n" % numeric(bundle.get("validation_accuracy")))
    seed.write("  %s,\n" % numeric(bundle.get("test_accuracy")))
    seed.write("  %s,\n" % q(bundle["model_checksum"]))
    seed.write("  %s,\n" % q(bundle.get("trained_at")))
    seed.write("  now(),\n")
    seed.write("  %s,\n" % jsonb(part_summary(report)))
    seed.write("  %s,\n" % jsonb(severity))
    seed.write("  %s,\n" % q("reports/training-report.json"))
    seed.write("  'production',\n")
    seed.write("  %s\n" % q(notes))
    seed.write(
        """)
on conflict (model_name, version) do update set
  dataset_id            = excluded.dataset_id,
  dataset_version       = excluded.dataset_version,
  model_architecture    = excluded.model_architecture,
  storage_path          = excluded.storage_path,
  classes               = excluded.classes,
  classes_by_part       = excluded.classes_by_part,
  input_size            = excluded.input_size,
  preprocessing_method  = excluded.preprocessing_method,
  validation_accuracy   = excluded.validation_accuracy,
  test_accuracy         = excluded.test_accuracy,
  model_checksum        = excluded.model_checksum,
  trained_at            = excluded.trained_at,
  promoted_at           = now(),
  part_summary          = excluded.part_summary,
  severity_support      = excluded.severity_support,
  training_report_path  = excluded.training_report_path,
  status                = 'production',
  notes                 = excluded.notes,
  updated_at            = now();

-- --------------------------------------------------------------------------
-- 3. show what was registered
-- --------------------------------------------------------------------------
select model_name,
       version,
       status,
       storage_path,
       model_architecture,
       input_size,
       test_accuracy,
       validation_accuracy,
       left(model_checksum, 16) || '...' as model_checksum,
       classes
  from public.model_versions
 where model_name = %s
 order by created_at desc;

commit;
"""
        % q(bundle["model_name"])
    )

    OUT_SEED.write_text(seed.getvalue(), encoding="utf-8")
    print("wrote %s (%d lines)" % (OUT_SEED.relative_to(ROOT), len(seed.getvalue().splitlines())))

    # ---- single-paste bundle -------------------------------------------- #
    combined = io.StringIO()
    combined.write(
        """-- ==========================================================================
-- CitrusGuard - ONE-PASTE SETUP
-- ==========================================================================
-- GENERATED FILE - do not hand-edit.
-- Regenerate with:  python scripts/generate_model_registration.py
--
-- PART A is the schema (supabase/combined_migration.sql). It is NOT idempotent
-- - it uses bare `create table` / `create type` - so run this file exactly ONCE
-- on a database where the migrations have never been applied. Running it twice
-- will fail on `type ... already exists`, which is the intended signal.
--
-- PART B registers the real, already-trained model and is idempotent.
--
-- How to run:
--   Supabase Dashboard -> your project -> SQL Editor -> New query
--   paste this whole file -> Run.
-- ==========================================================================

-- ##########################################################################
-- PART A - schema
-- ##########################################################################
"""
    )
    for path in MIGRATIONS:
        if not path.is_file():
            raise GeneratorError("missing migration: %s" % path.relative_to(ROOT))
        combined.write("\n-- ---- %s " % path.name)
        combined.write("-" * max(0, 66 - len(path.name)) + "\n")
        combined.write(path.read_text(encoding="utf-8").rstrip() + "\n")
    combined.write(
        """

-- ##########################################################################
-- PART B - register the real dataset + the real trained model
-- ##########################################################################
"""
    )
    combined.write(seed.getvalue())
    OUT_ALL.write_text(combined.getvalue(), encoding="utf-8")
    print("wrote %s (%d lines)" % (OUT_ALL.relative_to(ROOT), len(combined.getvalue().splitlines())))

    print()
    print("registered model : %s %s (%s)" % (bundle["model_name"], version, bundle["model_architecture"]))
    print("storage_path     : %s" % storage_path)
    print("model_checksum   : %s" % bundle["model_checksum"])
    print("artefacts        : %s" % ", ".join(sorted(artefacts.values())))
    print("classes          : %s" % ", ".join(all_classes))
    print("test_accuracy    : %s (mean over both heads: %s)" % (bundle.get("test_accuracy"), report.get("mean_test_accuracy")))
    print("dataset checksum : %s" % dataset.get("checksum"))
    print("image_quality    : %s" % json.dumps(image_quality))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GeneratorError as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        sys.exit(1)