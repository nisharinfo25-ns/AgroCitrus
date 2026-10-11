"""Deterministic, stratified train/validation/test split.

The split is stratified *within each (part, class) folder* and is seeded, so
repeated runs over an unchanged dataset produce byte-identical partitions and
model comparisons stay meaningful. Files are copied (not moved) from
``raw/`` into ``processed/<part>/<split>/<class>/`` and the resulting
``split_manifest.json`` records the exact assignment for every image.
"""

from __future__ import annotations

import json
import random
import shutil
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..common.errors import ValidationError
from ..common.paths import dataset_processed_dir, get_logger
from ..config.loader import DatasetConfig
from .classes import normalise_class_folders
from .validator import DiscoveredLayout, discover_layout, read_manifest

log = get_logger("dataset.splitter")

SPLIT_FILE = "split_manifest.json"
SPLITS = ("train", "validation", "test")


@dataclass
class SplitResult:
    parts: list[str] = field(default_factory=list)
    classes: dict[str, list[str]] = field(default_factory=dict)
    counts: dict[str, dict[str, int]] = field(default_factory=dict)
    total: int = 0
    ratios: dict[str, float] = field(default_factory=dict)
    seed: int = 0
    output_dir: str = ""
    assignments: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "parts": self.parts,
            "classes": self.classes,
            "counts": self.counts,
            "total": self.total,
            "ratios": self.ratios,
            "seed": self.seed,
            "output_dir": self.output_dir,
            "assignments": self.assignments,
        }


def _allocate(count: int, ratios: dict[str, float]) -> dict[str, int]:
    """Split ``count`` items across train/validation/test without loss.

    Guarantees every non-empty split receives at least one item when the class
    has enough images, so a rare class never produces an empty validation fold.
    """
    raw = {name: count * ratios[name] for name in SPLITS}
    counts = {name: int(raw[name]) for name in SPLITS}

    if count >= len(SPLITS):
        for name in SPLITS:
            if counts[name] == 0:
                counts[name] = 1
    else:
        # Too few images to populate all three folds: put everything in train.
        return {name: (count if name == "train" else 0) for name in SPLITS}

    # Hand the remainder to the largest fold, then fix any overflow.
    remainder = count - sum(counts.values())
    if remainder > 0:
        largest = max(SPLITS, key=lambda n: counts[n])
        counts[largest] += remainder
    elif remainder < 0:
        order = sorted(SPLITS, key=lambda n: counts[n])
        deficit = -remainder
        for name in order:
            take = min(deficit, counts[name] - 1 if counts[name] > 1 else 0)
            counts[name] -= take
            deficit -= take
            if deficit == 0:
                break
        if deficit > 0:
            counts["train"] -= deficit
    return counts


def split_dataset(
    raw_root: Path,
    config: DatasetConfig,
    model_cfg: dict[str, Any],
    *,
    seed: int | None = None,
    output_root: Path | None = None,
    force: bool = False,
) -> SplitResult:
    """Build the stratified split tree under ``data/citrus/processed/``."""
    raw_root = Path(raw_root)
    # The published archive is not internally consistent about casing
    # ("Canker" under Fruits, "canker" under Leaves). Without normalisation the
    # two heads would expose the same disease under different keys, so the
    # canonical folder name for a part is derived here and used everywhere
    # downstream (folders, manifest, exported config, database).
    normalise_class_folders(raw_root, config)
    output_root = Path(output_root or dataset_processed_dir())
    seed = int(model_cfg.get("model", {}).get("seed", 1337)) if seed is None else int(seed)
    ratios = {
        "train": float(model_cfg["training"]["split"]["train"]),
        "validation": float(model_cfg["training"]["split"]["validation"]),
        "test": float(model_cfg["training"]["split"]["test"]),
    }
    total_ratio = sum(ratios.values()) or 1.0
    ratios = {k: v / total_ratio for k, v in ratios.items()}

    if output_root.exists():
        if force:
            shutil.rmtree(output_root)
        elif not (output_root / SPLIT_FILE).is_file():
            shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    if (output_root / SPLIT_FILE).is_file() and not force:
        cached = json.loads((output_root / SPLIT_FILE).read_text(encoding="utf-8"))
        log.info("Reusing existing split at %s", output_root)
        return SplitResult(
            parts=cached["parts"],
            classes=cached["classes"],
            counts=cached["counts"],
            total=cached["total"],
            ratios=cached["ratios"],
            seed=cached["seed"],
            output_dir=str(output_root),
            assignments=cached.get("assignments", []),
        )

    layout: DiscoveredLayout = discover_layout(raw_root, config)
    if layout.total_images == 0:
        raise ValidationError("No usable images found in the raw dataset directory.")

    rng = random.Random(seed)
    grouped: dict[tuple[str, str], list[str]] = defaultdict(list)
    for record in layout.files:
        grouped[(record.part, record.class_name)].append(record.path)

    result = SplitResult(parts=layout.parts, seed=seed, ratios=ratios, output_dir=str(output_root))

    for part in layout.parts:
        part_classes = sorted(
            (c for (p, c) in grouped if p == part), key=lambda c: c.lower()
        )
        if not part_classes:
            log.warning("Part %r has no images; skipping.", part)
            continue
        result.classes[part] = part_classes
        result.counts[part] = {}

        for class_name in part_classes:
            paths = sorted(grouped[(part, class_name)])
            rng.shuffle(paths)
            allocation = _allocate(len(paths), ratios)
            cursor = 0
            for split in SPLITS:
                take = allocation[split]
                if take <= 0:
                    continue
                chosen = paths[cursor : cursor + take]
                cursor += take
                destination_dir = output_root / part.lower() / split / class_name
                destination_dir.mkdir(parents=True, exist_ok=True)
                for relative in chosen:
                    source = raw_root / relative
                    target = destination_dir / Path(relative).name
                    shutil.copy2(source, target)
                    result.assignments.append(
                        {
                            "source": relative,
                            "destination": str(target.relative_to(output_root)).replace("\\", "/"),
                            "part": part,
                            "class": class_name,
                            "split": split,
                        }
                    )
                result.counts[part].setdefault(split, 0)
                result.counts[part][split] = result.counts[part].get(split, 0) + take
            result.total += cursor
            if cursor != len(paths):
                raise ValidationError(
                    f"Split allocation lost images for {part}/{class_name}: "
                    f"{cursor} of {len(paths)} assigned."
                )

    if result.total != layout.total_images:
        raise ValidationError(
            f"Split total {result.total} does not match dataset size {layout.total_images}."
        )

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **result.to_dict(),
    }
    (output_root / SPLIT_FILE).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    log.info(
        "Split complete: %d images -> %s",
        result.total,
        {p: result.counts[p] for p in result.parts},
    )
    return result


def load_split(output_root: Path | None = None) -> SplitResult:
    """Load a previously computed split, or raise if it is missing."""
    output_root = Path(output_root or dataset_processed_dir())
    path = output_root / SPLIT_FILE
    if not path.is_file():
        raise ValidationError(
            "No prepared split found. Run `python -m citrusguard dataset prepare` first.",
            detail=str(path),
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    return SplitResult(
        parts=data["parts"],
        classes=data["classes"],
        counts=data["counts"],
        total=data["total"],
        ratios=data.get("ratios", {}),
        seed=data.get("seed", 0),
        output_dir=str(output_root),
        assignments=data.get("assignments", []),
    )


def load_raw_classes(raw_root: Path, config: DatasetConfig) -> dict[str, list[str]]:
    manifest = read_manifest(raw_root)
    if manifest:
        parts = manifest.get("parts", [])
        by_part = manifest.get("counts_by_part", {})
        return {part: sorted(by_part.get(part, {}).keys(), key=str.lower) for part in parts}
    return discover_layout(raw_root, config).by_part and {
        part: sorted(classes.keys(), key=str.lower)
        for part, classes in discover_layout(raw_root, config).by_part.items()
    }
