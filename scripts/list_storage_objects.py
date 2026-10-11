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
key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

client = create_client(url, key)

bucket = client.storage.from_("trained-models")

print("Listing root:")
print(bucket.list(""))

print("Listing production/:")
print(bucket.list("production"))

print("Listing versions/:")
print(bucket.list("versions"))

print("Listing versions/v2/:")
print(bucket.list("versions/v2"))
