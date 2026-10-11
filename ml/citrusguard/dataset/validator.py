"""Dataset validation and manifest generation.

Nothing about the disease classes is assumed: :func:`discover_layout` walks the
extracted tree, so the class list stored in PostgreSQL is always the list that
is physically present on disk.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from ..common.errors import ValidationError
from ..common.paths import get_logger
from ..config.loader import DatasetConfig

log = get_logger("dataset.validator")

MANIFEST_NAME = "manifest.json"
# Formats OpenCV can actually decode. Anything else is "unsupported", not
# silently skipped.
_DECODABLE = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".ppm", ".pgm"}


@dataclass
class FileRecord:
    path: str
    part: str
    class_name: str
    extension: str
    size_bytes: int


@dataclass
class ClassBucket:
    name: str
    part: str
    count: int


@dataclass
class DiscoveredLayout:
    """Ground truth read off the filesystem."""

    parts: list[str] = field(default_factory=list)
    classes: list[str] = field(default_factory=list)
    by_part: dict[str, dict[str, int]] = field(default_factory=dict)
    files: list[FileRecord] = field(default_factory=list)
    total_images: int = 0
    corrupt: list[dict[str, str]] = field(default_factory=list)
    unsupported: list[dict[str, str]] = field(default_factory=list)
    skipped_metadata: list[str] = field(default_factory=list)
    duplicates: list[dict[str, str]] = field(default_factory=list)

    def healthy(self) -> bool:
        return not self.corrupt and not self.unsupported


def manifest_path(root: Path) -> Path:
    return Path(root) / MANIFEST_NAME


def _is_ignored(path: Path | str, cfg: DatasetConfig) -> bool:
    """True when a path component is a known OS/junk artefact.

    Accepts a ``str`` as well as a ``Path`` because callers pass bare directory
    names (``_is_ignored(d.name, cfg)``) as well as relative paths.
    """
    parts = Path(path).parts
    return bool(parts) and (any(part in cfg.ignore_names for part in parts) or parts[-1] in cfg.ignore_names)


def _extension(path: Path) -> str:
    return path.suffix.lower()


def _decodeable(path: Path) -> bool:
    """Confirm OpenCV can actually open the file, not just that the extension
    claims to be an image. This is what separates 'corrupt' from 'unsupported'."""
    try:
        import cv2
    except ModuleNotFoundError:  # pragma: no cover
        return True
    try:
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    except Exception:
        return False
    return image is not None


def discover_layout(root: Path, cfg: DatasetConfig) -> DiscoveredLayout:
    """Walk ``root`` and build the authoritative class inventory."""
    root = Path(root)
    if not root.is_dir():
        raise ValidationError(
            "Dataset directory not found. Run the dataset download step first.",
            detail=str(root),
        )

    layout = DiscoveredLayout()
    by_part_dirs: dict[str, Path] = {}
    for part in cfg.parts:
        candidate = root / part
        if candidate.is_dir():
            by_part_dirs[part] = candidate
        else:
            log.warning("Configured part folder %r not present under %s", part, root)

    if not by_part_dirs:
        # Tolerate a differently-cased root but never invent a part.
        for child in sorted(root.iterdir()):
            if child.is_dir() and not _is_ignored(child.relative_to(root), cfg):
                by_part_dirs[child.name] = child
                log.info("Detected part folder %r (not listed in config)", child.name)

    seen_digests: dict[str, FileRecord] = {}
    classes: set[str] = set()

    for part, part_dir in sorted(by_part_dirs.items()):
        layout.parts.append(part)
        layout.by_part[part] = {}
        class_dirs = sorted(
            (d for d in part_dir.iterdir() if d.is_dir() and not _is_ignored(d.name, cfg)),
            key=lambda d: d.name.lower(),
        )
        for class_dir in class_dirs:
            class_name = class_dir.name
            classes.add(class_name)
            count = 0
            for file_path in sorted(class_dir.rglob("*")):
                if not file_path.is_file():
                    continue
                rel = file_path.relative_to(root)
                if _is_ignored(rel, cfg) or file_path.name.startswith("."):
                    layout.skipped_metadata.append(str(rel))
                    continue
                ext = _extension(file_path)
                size = file_path.stat().st_size
                if ext not in cfg.allowed_extensions:
                    layout.unsupported.append(
                        {"path": str(rel), "reason": f"unsupported extension '{ext or 'none'}'"}
                    )
                    continue
                if size < cfg.min_file_bytes:
                    layout.corrupt.append(
                        {"path": str(rel), "reason": f"file too small ({size} bytes)"}
                    )
                    continue
                if not _decodeable(file_path):
                    layout.corrupt.append(
                        {"path": str(rel), "reason": "image could not be decoded"}
                    )
                    continue

                digest = _quick_digest(file_path)
                if digest in seen_digests:
                    layout.duplicates.append(
                        {"path": str(rel), "duplicate_of": seen_digests[digest].path}
                    )
                else:
                    seen_digests[digest] = FileRecord(
                        path=str(rel), part=part, class_name=class_name, extension=ext, size_bytes=size
                    )

                layout.files.append(
                    FileRecord(
                        path=str(rel),
                        part=part,
                        class_name=class_name,
                        extension=ext,
                        size_bytes=size,
                    )
                )
                count += 1
            layout.by_part[part][class_name] = count

    layout.classes = sorted(classes, key=lambda c: c.lower())
    layout.total_images = len(layout.files)
    return layout


def summarise_counts(layout: DiscoveredLayout) -> dict[str, int]:
    """Compact per-(part, class) counts for the admin UI."""
    return {
        f"{part}/{class_name}": count
        for part, classes in layout.by_part.items()
        for class_name, count in classes.items()
    }


def _quick_digest(path: Path, chunk: int = 65536) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        digest.update(handle.read(chunk))
    return digest.hexdigest()


def content_checksum(root: Path, layout: DiscoveredLayout) -> str:
    """Deterministic SHA-256 over the *content* of the dataset.

    The publisher re-packages its zip on every request, so the archive's own
    bytes change between downloads and cannot be pinned. Hashing the sorted
    ``(relative path, byte size, full-file sha256)`` triples instead gives a
    stable identity for a given dataset build, which is what
    ``dataset_metadata.checksum`` records and what ``verify`` re-checks.
    """
    import hashlib

    root = Path(root)
    digest = hashlib.sha256()
    for record in sorted(layout.files, key=lambda r: r.path.replace("\\", "/")):
        path = root / record.path
        digest.update(record.path.replace("\\", "/").encode("utf-8"))
        digest.update(str(record.size_bytes).encode("ascii"))
        digest.update(_full_digest(path).encode("ascii"))
    return digest.hexdigest()


def _full_digest(path: Path, chunk: int = 1024 * 1024) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def read_manifest(root: Path) -> dict[str, Any] | None:
    path = manifest_path(root)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        log.warning("Dataset manifest is corrupt; it will be regenerated.")
        return None


def write_manifest(
    root: Path,
    cfg: DatasetConfig,
    layout: DiscoveredLayout,
    *,
    extra: dict[str, Any] | None = None,
) -> Path:
    """Serialise the manifest that PostgreSQL ``dataset_metadata`` mirrors."""
    root = Path(root)
    previous = read_manifest(root) or {}
    manifest: dict[str, Any] = {
        "manifest_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_name": cfg.name,
        "dataset_version": cfg.version,
        "source_url": cfg.source_url,
        "landing_page": cfg.landing_page,
        "license": cfg.license,
        "license_url": cfg.license_url,
        "doi": cfg.doi,
        "attribution": cfg.attribution,
        # `checksum` is the deterministic content checksum; the archive hash is
        # recorded separately because the publisher re-packages it per request.
        "checksum": content_checksum(root, layout),
        "checksum_kind": "content-sha256",
        "archive_sha256": (extra or {}).get("archive_sha256", ""),
        "parts": layout.parts,
        "classes": layout.classes,
        "class_count": len(layout.classes),
        "image_count": layout.total_images,
        "counts_by_part": layout.by_part,
        "corrupt": layout.corrupt,
        "unsupported": layout.unsupported,
        "duplicates": layout.duplicates,
        "healthy": layout.healthy(),
        "files": [asdict(f) for f in layout.files],
    }
    if previous.get("downloaded_at"):
        manifest["downloaded_at"] = previous["downloaded_at"]
    else:
        manifest["downloaded_at"] = manifest["generated_at"]
    manifest.update(extra or {})

    path = manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("Wrote dataset manifest -> %s", path)
    return path


def verify(root: Path, cfg: DatasetConfig, *, min_images_per_class: int | None = None) -> dict[str, Any]:
    """Re-run discovery and assert the dataset is fit for training.

    Raises :class:`ValidationError` with an actionable message when it is not.
    """
    layout = discover_layout(root, cfg)
    threshold = cfg.min_images_per_class if min_images_per_class is None else min_images_per_class
    problems: list[str] = []

    if not layout.parts:
        problems.append("No part folders (Leaf/Fruit categories) were found.")
    if not layout.classes:
        problems.append("No class folders were found.")
    if layout.corrupt:
        problems.append(
            f"{len(layout.corrupt)} corrupted image(s) detected, e.g. "
            f"{layout.corrupt[0]['path']} ({layout.corrupt[0]['reason']})."
        )
    if layout.unsupported:
        problems.append(
            f"{len(layout.unsupported)} unsupported file(s) detected, e.g. "
            f"{layout.unsupported[0]['path']} ({layout.unsupported[0]['reason']})."
        )
    for part, classes in layout.by_part.items():
        for class_name, count in classes.items():
            if count < threshold:
                problems.append(
                    f"Class '{class_name}' ({part}) has only {count} image(s); "
                    f"at least {threshold} are required for a stratified split."
                )
    if layout.total_images == 0:
        problems.append("The dataset contains no usable images.")

    report = {
        "healthy": not problems,
        "problems": problems,
        "image_count": layout.total_images,
        "class_count": len(layout.classes),
        "classes": layout.classes,
        "parts": layout.parts,
        "counts_by_part": layout.by_part,
        "checksum": content_checksum(root, layout),
        "corrupt_count": len(layout.corrupt),
        "unsupported_count": len(layout.unsupported),
        "duplicate_count": len(layout.duplicates),
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    if problems:
        raise ValidationError(
            "Dataset validation failed. " + " ".join(problems),
            detail="; ".join(problems),
        )
    log.info("Dataset verification passed: %d images / %d classes", layout.total_images, len(layout.classes))
    return report


def iter_images(root: Path, cfg: DatasetConfig) -> Iterable[tuple[Path, str, str]]:
    """Yield ``(path, part, class_name)`` for every usable image."""
    layout = discover_layout(root, cfg)
    for record in layout.files:
        yield root / record.path, record.part, record.class_name
