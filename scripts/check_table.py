import os
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
key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

client = create_client(url, key)

try:
    r = client.table("model_versions").select("id, version, status").execute()
    print("SUCCESS: Table model_versions exists! Rows:", r.data)
except Exception as e:
    print("Table check result:", e)
