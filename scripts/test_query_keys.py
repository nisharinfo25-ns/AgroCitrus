import os, json
from pathlib import Path

def load_dotenv(path):
    if not Path(path).is_file(): return
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ[k.strip()] = v.strip().strip('"').strip("'")

load_dotenv(".env.local")

from supabase import create_client
url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
anon_key = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

print("URL:", url)
print("Anon key present:", bool(anon_key))
print("Service key present:", bool(service_key))

# Test with ANON key (what browser / authenticated user uses via RLS)
anon_client = create_client(url, anon_key)
try:
    r_anon = anon_client.table("model_versions").select("version, model_architecture, classes, test_accuracy, validation_accuracy, input_size, preprocessing_method, trained_at, severity_support").eq("status", "production").limit(1).execute()
    print("ANON client query result data:", r_anon.data)
except Exception as e:
    print("ANON client query error:", e)

# Test with SERVICE ROLE key
service_client = create_client(url, service_key)
try:
    r_service = service_client.table("model_versions").select("version, model_architecture, classes, test_accuracy, validation_accuracy, input_size, preprocessing_method, trained_at, severity_support").eq("status", "production").limit(1).execute()
    print("SERVICE client query result data:", r_service.data)
except Exception as e:
    print("SERVICE client query error:", e)
