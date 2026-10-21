import json
from pathlib import Path

PROJ = Path("C:/Users/NISHAR AHAMED N/Desktop/Mini Project")

# Read config for all versions to compare class orderings
for v in ['v1','v2','v3','v4']:
    cfg_path = PROJ / 'models' / 'versions' / v / 'config.json'
    if not cfg_path.exists():
        print(f"Version {v}: no config.json")
        continue
    cfg = json.loads(cfg_path.read_text())
    cbp = cfg.get('classes_by_part', {})
    print(f"Version {v}:")
    for part, classes in cbp.items():
        print(f"  {part}: {classes}")
    routing = cfg.get('routing') or {}
    rc = routing.get('classes')
    if rc:
        print(f"  routing.classes: {rc}")
    print(f"  preprocessing_method: {cfg.get('preprocessing_method')}")
    print()

# Also check v4 checksum vs production checksum
print("=== Checksum comparison ===")
v4_cfg = json.loads((PROJ / 'models/versions/v4/config.json').read_text())
prod_cfg = json.loads((PROJ / 'models/production/config.json').read_text())

print("v4 checksums:", json.dumps(v4_cfg.get('checksums'), indent=2))
print("prod checksums:", json.dumps(prod_cfg.get('checksums'), indent=2))
print("v4 model_checksum:", v4_cfg.get('model_checksum'))
print("prod model_checksum:", prod_cfg.get('model_checksum'))
