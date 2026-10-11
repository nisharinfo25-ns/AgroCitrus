"""Calibrate `min_sharpness` against the real published dataset.

Runs the production code path - `image_quality.assess_image`, the same function
the inference worker calls - over every raw image in `data/citrus/raw`, and
reports the distribution of the measured sharpness plus the pass rate each
candidate threshold would produce.

Read-only: it prints a table and writes `reports/sharpness-calibration.json`.
Nothing under `data/` is modified.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "ml"))

from citrusguard.config.loader import model_config  # noqa: E402
from citrusguard.inference.image_quality import assess_image  # noqa: E402

RAW = REPO / "data" / "citrus" / "raw"
REPORT = REPO / "reports" / "sharpness-calibration.json"
SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

CANDIDATES = [0.0, 2.0, 3.0, 5.0, 8.0, 10.0, 12.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 50.0]


def percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile; stable and needs no interpolation choices."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    rank = max(1, min(len(ordered), int(round(q / 100.0 * len(ordered) + 0.5))))
    return ordered[rank - 1]


def main() -> int:
    config = model_config()
    thresholds = config["inference"]["image_quality"]

    images = sorted(p for p in RAW.rglob("*") if p.suffix.lower() in SUFFIXES)
    if not images:
        print(f"  No images under {RAW}")
        return 1

    rows: list[dict[str, object]] = []
    undecodable: list[str] = []
    by_class: dict[str, list[float]] = defaultdict(list)

    for path in images:
        try:
            report = assess_image(str(path), thresholds=thresholds)
        except Exception as error:  # noqa: BLE001 - a corrupt file is data, not a crash
            undecodable.append(f"{path.relative_to(RAW).as_posix()}: {type(error).__name__}")
            continue
        part = path.relative_to(RAW).parts[0]
        label = path.relative_to(RAW).parts[1] if len(path.relative_to(RAW).parts) > 2 else "(none)"
        rows.append(
            {
                "path": path.relative_to(RAW).as_posix(),
                "part": part,
                "class": label,
                "sharpness": round(report.sharpness, 4),
                "brightness": round(report.brightness, 4),
                "contrast": round(report.contrast, 4),
                "width": report.width,
                "height": report.height,
                "passed": report.passed,
            }
        )
        by_class[f"{part}/{label}"].append(report.sharpness)

    sharpness = [float(r["sharpness"]) for r in rows]

    print(f"\n  images analysed      : {len(rows)}   (undecodable: {len(undecodable)})")
    print(f"  working size         : {thresholds.get('sharpness_working_size')}")
    print(f"  configured threshold : min_sharpness = {thresholds.get('min_sharpness')}")
    print("\n  sharpness distribution (variance of the Laplacian at the working size)")
    print(f"    min    {min(sharpness):10.2f}")
    print(f"    p01    {percentile(sharpness, 1):10.2f}")
    print(f"    p05    {percentile(sharpness, 5):10.2f}")
    print(f"    p10    {percentile(sharpness, 10):10.2f}")
    print(f"    p25    {percentile(sharpness, 25):10.2f}")
    print(f"    median {statistics.median(sharpness):10.2f}")
    print(f"    p75    {percentile(sharpness, 75):10.2f}")
    print(f"    p90    {percentile(sharpness, 90):10.2f}")
    print(f"    p99    {percentile(sharpness, 99):10.2f}")
    print(f"    max    {max(sharpness):10.2f}")
    print(f"    mean   {statistics.fmean(sharpness):10.2f}")

    print("\n  pass rate by candidate threshold (sharpness-only, all other checks held at config)")
    print("    threshold   pass        fail   rejected %")
    for candidate in CANDIDATES:
        passed = sum(1 for value in sharpness if value >= candidate)
        failed = len(sharpness) - passed
        pct = (failed / len(sharpness) * 100.0) if sharpness else 0.0
        marker = "  <- configured" if candidate == float(thresholds.get("min_sharpness")) else ""
        print(f"    {candidate:9.1f}  {passed:5d}  {failed:7d}   {pct:8.2f}%{marker}")

    print("\n  overall gate result at the configured thresholds")
    failed_reasons: dict[str, int] = defaultdict(int)
    for row in rows:
        if not row["passed"]:
            failed_reasons[str(row["path"])] += 1
    rejected = sum(1 for row in rows if not row["passed"])
    print(f"    images failing at least one check : {rejected} / {len(rows)}")

    print("\n  sharpness by class (min / median / max) - texture dominates this metric")
    for key in sorted(by_class):
        values = by_class[key]
        print(
            f"    {key:<28} n={len(values):<4} "
            f"min {min(values):8.2f}   median {statistics.median(values):8.2f}   max {max(values):8.2f}"
        )

    if undecodable:
        print("\n  undecodable files:")
        for line in undecodable:
            print(f"    {line}")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
                "images_analysed": len(rows),
                "undecodable": undecodable,
                "working_size": thresholds.get("sharpness_working_size"),
                "configured_min_sharpness": thresholds.get("min_sharpness"),
                "distribution": {
                    "min": min(sharpness),
                    "p01": percentile(sharpness, 1),
                    "p05": percentile(sharpness, 5),
                    "p10": percentile(sharpness, 10),
                    "p25": percentile(sharpness, 25),
                    "median": statistics.median(sharpness),
                    "p75": percentile(sharpness, 75),
                    "p90": percentile(sharpness, 90),
                    "p99": percentile(sharpness, 99),
                    "max": max(sharpness),
                    "mean": statistics.fmean(sharpness),
                },
                "pass_rate_by_threshold": {
                    f"{candidate:.1f}": {
                        "passed": sum(1 for value in sharpness if value >= candidate),
                        "rejected_pct": round(
                            (len(sharpness) - sum(1 for value in sharpness if value >= candidate))
                            / len(sharpness)
                            * 100.0,
                            3,
                        ),
                    }
                    for candidate in CANDIDATES
                },
                "rejected_by_full_gate": rejected,
                "by_class": {
                    key: {
                        "count": len(values),
                        "min": round(min(values), 4),
                        "median": round(statistics.median(values), 4),
                        "max": round(max(values), 4),
                    }
                    for key, values in sorted(by_class.items())
                },
                "rows": rows,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\n  wrote {REPORT}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())