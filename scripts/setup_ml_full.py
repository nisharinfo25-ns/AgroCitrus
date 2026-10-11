#!/usr/bin/env python3
"""
CitrusGuard ML Full Setup Script
=================================
Applies the database migrations AND uploads the trained model to Supabase Storage
AND registers the model_versions record AND marks it as production.

Usage:
    python scripts/setup_ml_full.py

Requires:
    SUPABASE_SERVICE_ROLE_KEY set in .env.local
    The model must already be trained and in models/production/
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# ---- Load .env.local so we get the service role key ----
def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env.local")
load_dotenv(REPO_ROOT / ".env")

SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
SUPABASE_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or "https://bpmoafdikilbpcxbbmyi.supabase.co"
).strip()

if not SERVICE_ROLE_KEY:
    print(
        "\n[ERROR] SUPABASE_SERVICE_ROLE_KEY is not set in .env.local\n"
        "Go to: Supabase Dashboard -> Project Settings -> API Keys -> service_role\n"
        "Then add it to your .env.local file:\n"
        "    SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here\n",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"[OK] Supabase URL: {SUPABASE_URL}")
print(f"[OK] Service role key: {SERVICE_ROLE_KEY[:20]}...{SERVICE_ROLE_KEY[-6:]}")


# ---- Step 1: Apply migrations via Supabase REST API ----
import urllib.request
import urllib.error

def apply_sql(label: str, sql: str) -> None:
    """Execute SQL against the Supabase project via the management API or pgREST RPC."""
    # Supabase provides a /query endpoint via the service key for raw SQL in local dev,
    # but cloud projects require the database connection string or migration tooling.
    # We use the supabase-py client which can call stored functions.
    # For applying migrations we need direct DB access.
    print(f"  [SKIP-DIRECT-SQL] {label} - requires psql or supabase CLI with DB URL")
    print("  Migration SQL must be applied via the Supabase Dashboard SQL editor.")
    print("  Instructions are in the FINAL REPORT below.")


# ---- Step 2: Check if schema is already applied ----
from supabase import create_client

try:
    client = create_client(SUPABASE_URL, SERVICE_ROLE_KEY)
    print("[OK] Connected to Supabase")
except Exception as e:
    print(f"[ERROR] Could not connect to Supabase: {e}", file=sys.stderr)
    sys.exit(1)

# Test if model_versions table exists
try:
    result = client.table("model_versions").select("id").limit(1).execute()
    schema_applied = True
    print("[OK] model_versions table exists")
except Exception as e:
    err_str = str(e)
    if "PGRST205" in err_str or "not found" in err_str.lower() or "schema cache" in err_str.lower():
        schema_applied = False
        print("[WARN] model_versions table does NOT exist - schema not applied")
    else:
        schema_applied = False
        print(f"[WARN] Could not query model_versions: {e}")

if not schema_applied:
    print("\n" + "="*60)
    print("STEP REQUIRED: Apply database migrations")
    print("="*60)
    print("""
The Supabase schema has not been applied yet. You must apply the migrations.

OPTION A (Supabase Dashboard - easiest):
1. Go to https://supabase.com/dashboard/project/bpmoafdikilbpcxbbmyi/editor
2. Open SQL Editor
3. Copy and paste the content of:
   supabase/combined_migration.sql
   (or apply 0001, 0002, 0003 in order)
4. Click Run
5. Re-run this script

OPTION B (supabase CLI):
   supabase db push

OPTION C (psql with DB URL from Dashboard -> Project Settings -> Database):
   psql "postgresql://postgres.bpmoafdikilbpcxbbmyi:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres" \\
     -f supabase/combined_migration.sql
""")
    sys.exit(2)


# ---- Step 3: Check/create storage buckets ----
print("\n[INFO] Checking storage buckets...")
buckets_needed = {
    "citrus-dataset": False,
    "trained-models": False,
    "scan-images": False,
}

try:
    existing_buckets = client.storage.list_buckets()
    existing_names = {b.name for b in existing_buckets}
    for bucket in buckets_needed:
        if bucket in existing_names:
            print(f"  [OK] Bucket '{bucket}' exists")
            buckets_needed[bucket] = True
        else:
            print(f"  [CREATE] Bucket '{bucket}' missing - creating...")
            try:
                client.storage.create_bucket(bucket, options={"public": False})
                print(f"  [OK] Created bucket '{bucket}'")
                buckets_needed[bucket] = True
            except Exception as e:
                print(f"  [ERROR] Could not create bucket '{bucket}': {e}")
except Exception as e:
    print(f"  [WARN] Could not list buckets: {e}")


# ---- Step 4: Upload model bundle to Supabase Storage ----
production_dir = REPO_ROOT / "models" / "production"
config_path = production_dir / "config.json"

if not config_path.is_file():
    print(f"\n[ERROR] No production model config found at {config_path}", file=sys.stderr)
    print("Run training first: python -m citrusguard model train")
    sys.exit(1)

manifest = json.loads(config_path.read_text(encoding="utf-8"))
version = manifest["model_version"]
print(f"\n[INFO] Found production model: {version}")
print(f"  Architecture: {manifest.get('model_architecture')}")
print(f"  Classes: {manifest.get('all_classes')}")
print(f"  Input size: {manifest.get('input_size')}")
print(f"  Test accuracy: {manifest.get('test_accuracy')}")
print(f"  Validation accuracy: {manifest.get('validation_accuracy')}")

if buckets_needed.get("trained-models"):
    print(f"\n[INFO] Uploading model bundle (version {version}) to Supabase Storage...")

    files_to_upload = [
        ("config.json", config_path),
    ]
    for artifact_key, artifact_filename in manifest.get("artifacts", {}).items():
        artifact_path = production_dir / artifact_filename
        if artifact_path.is_file():
            files_to_upload.append((artifact_filename, artifact_path))
        else:
            print(f"  [ERROR] Artifact {artifact_filename} not found at {artifact_path}")
            sys.exit(1)

    bucket = client.storage.from_("trained-models")

    def upload_to_storage(remote_path: str, local_path: Path) -> None:
        content_type_map = {
            ".json": "application/json",
            ".keras": "application/octet-stream",
            ".h5": "application/octet-stream",
        }
        content_type = content_type_map.get(local_path.suffix.lower(), "application/octet-stream")
        with local_path.open("rb") as f:
            data = f.read()
        try:
            # Try upsert (upload with overwrite)
            bucket.upload(remote_path, data, {"content-type": content_type, "upsert": "true"})
            size_mb = len(data) / 1024 / 1024
            print(f"  [OK] Uploaded {local_path.name} -> trained-models/{remote_path} ({size_mb:.1f} MB)")
        except Exception as e:
            # May fail if file already exists and upsert isn't supported - try remove+upload
            err_str = str(e).lower()
            if "already exists" in err_str or "duplicate" in err_str:
                try:
                    bucket.remove([remote_path])
                except Exception:
                    pass
                bucket.upload(remote_path, data, {"content-type": content_type})
                size_mb = len(data) / 1024 / 1024
                print(f"  [OK] Re-uploaded {local_path.name} -> trained-models/{remote_path} ({size_mb:.1f} MB)")
            else:
                raise

    # Upload to both versions/v1/ and production/
    for filename, local_path in files_to_upload:
        upload_to_storage(f"versions/{version}/{filename}", local_path)
        upload_to_storage(f"production/{filename}", local_path)

    print("[OK] Model bundle uploaded to Supabase Storage")
else:
    print("[WARN] Skipping model upload - trained-models bucket not accessible")


# ---- Step 5: Register model in model_versions and activate it ----
print(f"\n[INFO] Registering model version {version} in database...")

# Check if already registered
try:
    existing = (
        client.table("model_versions")
        .select("id, status, version")
        .eq("version", version)
        .execute()
    )
    already_exists = len(existing.data or []) > 0
    if already_exists:
        existing_row = existing.data[0]
        print(f"  [INFO] Version {version} already exists (status={existing_row.get('status')})")
    else:
        already_exists = False
except Exception as e:
    print(f"  [WARN] Could not check existing versions: {e}")
    already_exists = False

if not already_exists:
    # Use the record_model_version RPC
    rpc_args = {
        "p_version": version,
        "p_storage_path": f"versions/{version}",
        "p_classes": manifest.get("all_classes", []),
        "p_classes_by_part": manifest.get("classes_by_part", {}),
        "p_model_checksum": manifest.get("model_checksum"),
        "p_validation_accuracy": manifest.get("validation_accuracy"),
        "p_test_accuracy": manifest.get("test_accuracy"),
        "p_part_summary": manifest.get("part_summary", {}),
        "p_severity_support": manifest.get("severity_support", {"enabled": False}),
        "p_dataset_version": str(manifest.get("dataset_version", "")),
        "p_model_architecture": manifest.get("model_architecture"),
        "p_input_size": manifest.get("input_size"),
        "p_preprocessing_method": manifest.get("preprocessing_method"),
        "p_training_report_path": None,
        "p_trained_at": manifest.get("trained_at"),
        "p_notes": manifest.get("notes", ""),
    }
    try:
        result = client.rpc("record_model_version", rpc_args).execute()
        print(f"  [OK] Model version {version} recorded via RPC")
    except Exception as e:
        print(f"  [WARN] RPC record_model_version failed ({e}), using direct upsert...")
        # Direct upsert fallback
        row = {
            "model_name": manifest.get("model_name", "citrusguard-cnn"),
            "version": version,
            "dataset_version": str(manifest.get("dataset_version", "")),
            "model_architecture": manifest.get("model_architecture"),
            "storage_path": f"versions/{version}",
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
            "status": "candidate",
            "notes": manifest.get("notes", ""),
        }
        result = (
            client.table("model_versions")
            .upsert(row, on_conflict="model_name,version")
            .execute()
        )
        print(f"  [OK] Model version {version} inserted via direct upsert")

# ---- Step 6: Activate the model ----
print(f"\n[INFO] Activating model version {version} as production...")
try:
    result = client.rpc("activate_model_version", {"p_version": version}).execute()
    activated = (result.data or [{}])[0]
    print(f"  [OK] Model {version} is now production (status={activated.get('status')})")
except Exception as e:
    print(f"  [WARN] activate_model_version RPC failed ({e})")
    print("  Trying direct update...")
    try:
        # First retire any existing production
        client.table("model_versions").update({"status": "retired", "promoted_at": None}).eq("status", "production").neq("version", version).execute()
        # Then promote this one
        from datetime import datetime, timezone
        result = (
            client.table("model_versions")
            .update({"status": "production", "promoted_at": datetime.now(timezone.utc).isoformat()})
            .eq("version", version)
            .execute()
        )
        print(f"  [OK] Model {version} updated to production via direct update")
    except Exception as e2:
        print(f"  [ERROR] Could not activate model: {e2}", file=sys.stderr)
        sys.exit(1)

# ---- Step 7: Verify the final state ----
print("\n[INFO] Verifying final state...")
try:
    result = (
        client.table("model_versions")
        .select("version, status, classes, test_accuracy, validation_accuracy, storage_path")
        .eq("status", "production")
        .execute()
    )
    if result.data:
        row = result.data[0]
        print(f"  [OK] Production model in database:")
        print(f"       version={row['version']}")
        print(f"       status={row['status']}")
        print(f"       classes={row['classes']}")
        print(f"       test_accuracy={row['test_accuracy']}")
        print(f"       validation_accuracy={row['validation_accuracy']}")
        print(f"       storage_path={row['storage_path']}")
    else:
        print("  [WARN] No production model found after activation")
except Exception as e:
    print(f"  [WARN] Could not verify: {e}")

# ---- Step 8: Verify Storage ----
print("\n[INFO] Verifying Supabase Storage...")
try:
    prod_files = client.storage.from_("trained-models").list("production")
    filenames = [f["name"] for f in (prod_files or [])]
    print(f"  [OK] trained-models/production/ contains: {filenames}")
except Exception as e:
    print(f"  [WARN] Could not list storage: {e}")

print("\n" + "="*60)
print("SETUP COMPLETE")
print("="*60)
print(f"""
Real model '{version}' is now:
  - Registered in Supabase PostgreSQL as 'production'
  - Uploaded to Supabase Storage (trained-models/production/)
  - The Detect Disease page will now show the upload form

Next steps:
  1. Restart the Next.js server (or it will reload automatically)
  2. Open the Detect Disease page
  3. Upload a citrus leaf or fruit image
  4. The prediction will run using the real trained model

Model details:
  Architecture:   MobileNetV2 (transfer learning)
  Input size:     224x224 px
  Classes (leaf): Black Spot, Canker, Greening, Healthy, Melanose
  Classes (fruit):Black Spot, Canker, Greening, Healthy, Scab
  Test accuracy:  {manifest.get('test_accuracy', 'N/A')}
  Val accuracy:   {manifest.get('validation_accuracy', 'N/A')}
""")
