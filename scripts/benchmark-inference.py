"""Before/after latency of the two inference paths.

Why this exists
---------------
"Make it faster" is not a measurable claim. This script produces the two numbers
that matter, on this machine, against whatever bundle is in ``models/production``:

  BEFORE  the one-shot worker (`python -m citrusguard.inference.worker`). This is
          exactly what the web app used to spawn per upload: a fresh interpreter,
          a full TensorFlow import and a fresh load of every ``.keras`` file, all
          before the image is looked at.

  AFTER   the long-lived server (`citrusguard.inference.server`). One warm-up
          pays the interpreter + import + load once; each later prediction is
          read + preprocess + forward pass + Grad-CAM and nothing else.

It reports the cold cost, the warm-up cost and the steady-state per-image cost,
so the improvement is a subtraction rather than an assertion. It uses a real
image from the dataset and the real production bundle - no synthetic timing.

    python scripts/benchmark-inference.py
    python scripts/benchmark-inference.py --bundle models/production --runs 5
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ML = ROOT / "ml"


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ML)
    env["PYTHONIOENCODING"] = "utf-8"
    env.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    env.setdefault("CITRUSGUARD_PROJECT_ROOT", str(ROOT))
    return env


def pick_image() -> Path:
    """First real image in the prepared raw tree, preferring a leaf."""
    for part in ("Leaves", "Fruits"):
        base = ROOT / "data" / "citrus" / "raw" / part
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.suffix.lower() in {".jpg", ".jpeg", ".png"}:
                return path
    raise SystemExit("No dataset image found under data/citrus/raw - run the dataset step first.")


def _request(image: Path, bundle: Path, out_dir: Path, gradcam: bool) -> dict:
    return {
        "image_path": str(image),
        "bundle_dir": str(bundle),
        "output_dir": str(out_dir),
        "processed_name": "processed.png",
        "enable_gradcam": gradcam,
    }


def one_shot(image: Path, bundle: Path, gradcam: bool) -> tuple[float, bool]:
    """Run one full one-shot worker subprocess; return (seconds, ok)."""
    out_dir = Path(tempfile.mkdtemp(prefix="cg-bench-cold-"))
    try:
        payload = json.dumps(_request(image, bundle, out_dir, gradcam))
        started = time.perf_counter()
        proc = subprocess.run(
            [sys.executable, "-m", "citrusguard.inference.worker"],
            input=payload.encode("utf-8"),
            capture_output=True,
            cwd=str(ML),
            env=_env(),
            timeout=900,
        )
        elapsed = time.perf_counter() - started
        ok = False
        for line in proc.stdout.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    ok = bool(json.loads(line).get("ok"))
                except json.JSONDecodeError:
                    pass
        return elapsed, ok
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


class Server:
    """Minimal client for the JSON-lines inference server."""

    def __init__(self, bundle: Path):
        self.bundle = bundle
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "citrusguard.inference.server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(ML),
            env=_env(),
            text=True,
            encoding="utf-8",
        )
        self._id = 0

    def call(self, payload: dict) -> dict:
        self._id += 1
        payload = {**payload, "id": self._id}
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("inference server closed stdout")
        return json.loads(line)

    def warm(self) -> float:
        started = time.perf_counter()
        self.call({"op": "load", "bundle_dir": str(self.bundle)})
        return time.perf_counter() - started

    def predict(self, image: Path, gradcam: bool) -> tuple[float, bool]:
        out_dir = Path(tempfile.mkdtemp(prefix="cg-bench-warm-"))
        try:
            started = time.perf_counter()
            response = self.call(_request(image, self.bundle, out_dir, gradcam))
            return time.perf_counter() - started, bool(response.get("ok"))
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def close(self) -> None:
        try:
            self.call({"op": "shutdown"})
        except Exception:
            pass
        self.proc.terminate()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=ROOT / "models" / "production")
    parser.add_argument("--runs", type=int, default=4)
    parser.add_argument("--no-gradcam", action="store_true", help="Disable Grad-CAM in both paths.")
    args = parser.parse_args()

    if not (args.bundle / "config.json").is_file():
        raise SystemExit(f"No bundle at {args.bundle}")

    gradcam = not args.no_gradcam
    image = pick_image()
    print(f"bundle   : {args.bundle}")
    print(f"image    : {image.relative_to(ROOT)}")
    print(f"gradcam  : {gradcam}")
    print()

    # ---- BEFORE: one-shot worker -------------------------------------- #
    cold, cold_ok = one_shot(image, args.bundle, gradcam)
    print("BEFORE - one-shot worker (interpreter start + TF import + model load + infer)")
    print(f"  run 1 (cold) : {cold:8.3f}s  ok={cold_ok}")
    for index in range(2, args.runs + 1):
        elapsed, ok = one_shot(image, args.bundle, gradcam)
        print(f"  run {index}        : {elapsed:8.3f}s  ok={ok}  (no reuse: same cost)")
    print()

    # ---- AFTER: warm server ------------------------------------------- #
    server = Server(args.bundle)
    try:
        warm = server.warm()
        print("AFTER - long-lived server (warm-up paid once, then reused)")
        print(f"  warm-up      : {warm:8.3f}s  (TF import + model load, once per process)")
        warm_times: list[float] = []
        warm_ok = True
        for index in range(1, args.runs + 1):
            elapsed, ok = server.predict(image, gradcam)
            warm_times.append(elapsed)
            warm_ok = warm_ok and ok
            print(f"  predict {index}    : {elapsed:8.3f}s  ok={ok}")
    finally:
        server.close()

    print()
    if warm_times:
        mean_warm = sum(warm_times) / len(warm_times)
        print("SUMMARY")
        print(f"  cold one-shot request     : {cold:8.3f}s")
        print(f"  warm-up (once)            : {warm:8.3f}s")
        print(f"  warm request (mean of {len(warm_times)}) : {mean_warm:8.3f}s")
        if cold > 0:
            print(f"  per-request speed-up      : {cold / mean_warm:8.1f}x")
    return 0


if __name__ == "__main__":
    sys.exit(main())
