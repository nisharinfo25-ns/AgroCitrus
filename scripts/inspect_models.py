"""Inspect model architectures and output classes to debug Canker→Greening mis-prediction."""
import sys
import json
import numpy as np
from pathlib import Path

# Add ml/ to path
sys.path.insert(0, str(Path(__file__).parent.parent / "ml"))

try:
    import tensorflow as tf
    TF_OK = True
except ImportError:
    TF_OK = False

ROOT = Path(__file__).parent.parent
PROD_DIR = ROOT / "models" / "production"
CACHE_DIR = ROOT / ".cache" / "citrusguard" / "models"

def inspect_model(path: Path, label: str) -> None:
    if not path.exists():
        print(f"  MISSING: {path}")
        return
    try:
        m = tf.keras.models.load_model(str(path), compile=False)
    except Exception as e:
        print(f"  LOAD ERROR: {e}")
        return
    out_layer = m.layers[-1]
    act = getattr(out_layer, "activation", None)
    act_name = getattr(act, "__name__", str(act))
    print(f"  output_shape : {m.output_shape}")
    print(f"  final_layer  : {out_layer.name}")
    print(f"  activation   : {act_name}")

    # Quick sanity: forward pass on a blank image
    dummy = np.zeros((1, 224, 224, 3), dtype=np.float32)
    raw = m.predict(dummy, verbose=0)
    if hasattr(raw, "numpy"):
        raw = raw.numpy()
    raw = np.array(raw).reshape(-1)
    print(f"  num_outputs  : {raw.shape[0]}")
    print(f"  blank_probs  : min={raw.min():.4f}, max={raw.max():.4f}, sum={raw.sum():.4f}")
    print(f"  blank_argmax : {int(np.argmax(raw))}")


def show_config(cfg_path: Path, label: str) -> dict:
    if not cfg_path.exists():
        print(f"[{label}] config.json NOT FOUND at {cfg_path}")
        return {}
    cfg = json.loads(cfg_path.read_text())
    print(f"\n=== [{label}] config.json ===")
    print(f"  model_version      : {cfg.get('model_version')}")
    print(f"  preprocessing_method: {cfg.get('preprocessing_method')}")
    print(f"  input_size         : {cfg.get('input_size')}")
    print(f"  artifacts          : {cfg.get('artifacts')}")
    cbp = cfg.get("classes_by_part", {})
    for part, classes in cbp.items():
        print(f"  {part} classes ({len(classes)}): {classes}")
    routing = cfg.get("routing")
    if routing:
        print(f"  routing.classes    : {routing.get('classes')}")
        print(f"  routing.min_conf   : {routing.get('min_confidence')}")
    return cfg

if __name__ == "__main__":
    if not TF_OK:
        print("TensorFlow not available")
        sys.exit(1)

    # Show configs
    prod_cfg = show_config(PROD_DIR / "config.json", "production")
    if (CACHE_DIR / "config.json").exists():
        cache_cfg = show_config(CACHE_DIR / "config.json", "cache")

    # Inspect each model
    print("\n=== Model Architecture Inspection ===")
    for name in ["part_leaf", "part_fruit", "part_router"]:
        for directory, label in [(PROD_DIR, "prod"), (CACHE_DIR, "cache")]:
            p = directory / f"{name}.keras"
            if p.exists():
                print(f"\n-- {name} [{label}] --")
                inspect_model(p, f"{name}/{label}")
                break

    # Checksums
    print("\n=== Checksum Verification ===")
    import hashlib
    recorded = prod_cfg.get("checksums", {})
    for name, filename in (prod_cfg.get("artifacts") or {}).items():
        artifact = PROD_DIR / filename
        if artifact.exists():
            h = hashlib.sha256()
            for chunk in iter(lambda: artifact.read_bytes(), b""):
                h.update(chunk)
                break  # just do it in one go for small files
            digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
            expected = recorded.get(name, "???")
            match = "OK" if digest == expected else "MISMATCH"
            print(f"  {name}: {match} (expected={expected[:16]}... actual={digest[:16]}...)")
        else:
            print(f"  {name}: MISSING at {artifact}")
