"""Canonical class-name normalisation.

The published archive names the same disease differently in different folders
(``Canker`` under ``Fruits/``, ``canker`` under ``Leaves/``). Left alone, the two
model heads would emit different keys for the same disease and the database
would accumulate near-duplicate rows.

:func:`normalise_class_folders` renames the on-disk class folders to a single
canonical spelling per class so the split, the exported model config, the
database and the UI all agree.

Case-safety note
----------------
On case-insensitive filesystems (Windows, default macOS) ``Path("Black Spot")
.exists()`` is true for a directory actually named ``Black spot``. Any logic
that treats "target exists" as "a *different* directory already exists" will
therefore match the folder itself and can delete its own contents. All
existence checks here are therefore made against the explicit directory
*listing* with an exact, case-sensitive name comparison, so a rename is always
a rename and never a self-merge.
"""

from __future__ import annotations

import re
from pathlib import Path

from ..common.paths import get_logger
from ..config.loader import DatasetConfig

log = get_logger("dataset.classes")

# Canonical spellings for the classes present in the published dataset.
# Anything not listed is title-cased generically rather than dropped.
CANONICAL: dict[str, str] = {
    "black spot": "Black Spot",
    "blackspot": "Black Spot",
    "black_spot": "Black Spot",
    "canker": "Canker",
    "greening": "Greening",
    "huanglongbing": "Greening",
    "hlb": "Greening",
    "melanose": "Melanose",
    "scab": "Scab",
    "healthy": "Healthy",
}

# Database slug for each canonical display name. The slug is the value stored
# in `scans.predicted_class` and `disease_information.slug`.
SLUGS: dict[str, str] = {
    "Black Spot": "black-spot",
    "Canker": "canker",
    "Greening": "greening",
    "Melanose": "melanose",
    "Scab": "scab",
    "Healthy": "healthy",
}


def _key(raw: str) -> str:
    return re.sub(r"[\s_\-]+", " ", raw.strip().lower()).strip()


def canonical_class_name(raw: str) -> str:
    """Map any spelling of a class to its canonical display name."""
    return CANONICAL.get(_key(raw), _key(raw).title())


def class_slug(raw: str) -> str:
    """Stable machine key for the database and API."""
    canonical = canonical_class_name(raw)
    if canonical in SLUGS:
        return SLUGS[canonical]
    return re.sub(r"[^a-z0-9]+", "-", canonical.lower()).strip("-")


def is_healthy_class(raw: str) -> bool:
    return _key(raw) == "healthy"


def merge_case_variants(names: list[str]) -> list[str]:
    """Collapse ``['canker', 'Canker']`` to one canonical entry."""
    merged: dict[str, str] = {}
    for name in names:
        canonical = canonical_class_name(name)
        merged.setdefault(canonical, canonical)
    return sorted(merged.values(), key=str.lower)


def _folder_names(directory: Path) -> set[str]:
    """Exact, case-sensitive set of subdirectory names."""
    return {child.name for child in directory.iterdir() if child.is_dir()}


def _list_files(directory: Path) -> list[Path]:
    return sorted(child for child in directory.iterdir() if child.is_file())


def normalise_class_folders(root: Path, cfg: DatasetConfig) -> dict[str, str]:
    """Rename class folders in place to their canonical spelling.

    Returns ``{old_name: new_name}``. Idempotent.

    Two genuinely distinct folders whose names differ only by case are merged
    (files moved across, source removed). A folder that is merely a differently
    cased spelling of *itself* is renamed with ``os.replace`` semantics, which
    is a no-op on a case-insensitive filesystem and a real rename on Linux.
    Either way no image is ever deleted.
    """
    root = Path(root)
    renamed: dict[str, str] = {}

    for part in cfg.parts:
        part_dir = root / part
        if not part_dir.is_dir():
            continue

        # Snapshot the exact names first: the set changes as we rename.
        for class_dir in sorted((p for p in part_dir.iterdir() if p.is_dir()), key=lambda p: p.name):
            original_name = class_dir.name
            canonical = canonical_class_name(original_name)
            existing = _folder_names(part_dir)

            if canonical == original_name:
                continue  # already canonical

            if canonical in existing:
                # A folder with the canonical spelling already exists: merge.
                target = part_dir / canonical
                for image in _list_files(class_dir):
                    destination = target / image.name
                    if destination.exists():
                        # Identical name already present: keep the existing file
                        # and drop only the exact duplicate.
                        log.warning(
                            "Duplicate filename %s in %r; keeping the copy in %r",
                            image.name,
                            original_name,
                            canonical,
                        )
                        image.unlink()
                    else:
                        image.rename(destination)
                for leftover in _list_files(class_dir):
                    leftover.unlink()
                class_dir.rmdir()
                log.info(
                    "Merged distinct class folder %r into %r under %s",
                    original_name,
                    canonical,
                    part,
                )
            else:
                # Case-only (or otherwise differing) rename. `rename` is a no-op
                # on a case-insensitive filesystem, which is exactly what we want.
                class_dir.rename(part_dir / canonical)
                log.info("Renamed class folder %r -> %r under %s", original_name, canonical, part)

            renamed[original_name] = canonical

    return renamed
