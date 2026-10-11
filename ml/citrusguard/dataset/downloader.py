"""Dataset acquisition.

Responsibilities (in order, each idempotent):

1.  Skip entirely when a previously verified extraction already exists.
2.  Stream the configured ``source_url`` to a local cache with bounded retries.
3.  Verify the SHA-256 against ``dataset.sha256`` when one is configured.
4.  Validate that the payload is a readable zip.
5.  Extract, transparently unwrapping nested archives (the Mendeley payload is
    a zip containing a single nested zip).
6.  Locate the class tree and flatten it into ``data/citrus/raw``.

Nothing here fabricates a fallback: if the source is unreachable the caller
gets a :class:`DownloadError` and the admin UI shows a setup error.
"""

from __future__ import annotations

import hashlib
import shutil
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from ..common.errors import (
    ArchiveError,
    ChecksumMismatchError,
    DownloadError,
    ValidationError,
)
from ..common.paths import (
    dataset_downloads_dir,
    dataset_raw_dir,
    ensure_dir,
    get_logger,
)
from ..config.loader import DatasetConfig, dataset_config
from .validator import discover_layout, manifest_path, write_manifest

log = get_logger("dataset.downloader")

_USER_AGENT = "CitrusGuard/1.0 (+https://github.com/citrusguard)"
_CHUNK = 1024 * 1024
_MAX_NESTING = 4


def _fetch_stream(url: str, destination: Path, timeout: int) -> tuple[int, str]:
    """Stream ``url`` to ``destination``. Returns (bytes, content-type).

    Publishers front their archives with bot-management layers that reject
    some HTTP client fingerprints outright. Rather than hard-coding one
    transport we try, in order: ``requests``, the standard library
    ``urllib``, and finally the system ``curl``. The first transport that
    yields a successful response wins, so the pipeline works behind the
    stricter CDNs without the caller having to know which one applies.
    """
    errors: list[str] = []

    for transport in (_fetch_requests, _fetch_urllib, _fetch_curl):
        try:
            return transport(url, destination, timeout)
        except Exception as exc:  # try the next transport
            errors.append(f"{transport.__name__}: {exc}")
            destination.unlink(missing_ok=True)

    raise DownloadError(
        "Could not download the dataset archive. Every HTTP transport failed; "
        "the source may be blocking automated access or be offline.",
        detail=" | ".join(errors),
    )


def _fetch_requests(url: str, destination: Path, timeout: int) -> tuple[int, str]:
    import requests

    with requests.get(
        url,
        stream=True,
        timeout=(30, timeout),
        headers={"User-Agent": _USER_AGENT, "Accept": "*/*"},
        allow_redirects=True,
    ) as response:
        if response.status_code >= 400:
            raise DownloadError(
                "Dataset source returned an error response.",
                detail=f"HTTP {response.status_code}",
            )
        content_type = (response.headers.get("Content-Type") or "").lower()
        with destination.open("wb") as handle:
            for block in response.iter_content(chunk_size=_CHUNK):
                if block:
                    handle.write(block)
    return destination.stat().st_size, content_type


def _fetch_urllib(url: str, destination: Path, timeout: int) -> tuple[int, str]:
    import urllib.request

    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        if response.status >= 400:
            raise DownloadError("Dataset source returned an error response.", detail=f"HTTP {response.status}")
        content_type = (response.headers.get("Content-Type") or "").lower()
        with destination.open("wb") as handle:
            while True:
                block = response.read(_CHUNK)
                if not block:
                    break
                handle.write(block)
    return destination.stat().st_size, content_type


def _fetch_curl(url: str, destination: Path, timeout: int) -> tuple[int, str]:
    import shutil as _shutil
    import subprocess

    executable = _shutil.which("curl")
    if not executable:
        raise DownloadError("curl is not available on this system.")
    completed = subprocess.run(  # noqa: S603
        [
            executable,
            "-sSL",
            "--fail",
            "--max-time",
            str(timeout),
            "-A",
            _USER_AGENT,
            "-o",
            str(destination),
            "-w",
            "%{http_code} %{content_type}",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=timeout + 60,
        check=False,
    )
    if completed.returncode != 0:
        raise DownloadError("curl failed.", detail=(completed.stderr or "").strip()[:400])
    status, _, content_type = (completed.stdout or "").partition(" ")
    if not status.startswith("2"):
        raise DownloadError("Dataset source returned an error response.", detail=f"HTTP {status}")
    return destination.stat().st_size, content_type.strip().lower()


@dataclass(frozen=True)
class DownloadResult:
    archive_path: Path
    checksum: str
    bytes_downloaded: int
    reused: bool
    extracted_path: Path
    unwrapped: int


# --------------------------------------------------------------------------- #
# Low level helpers
# --------------------------------------------------------------------------- #
def sha256_file(path: Path, chunk: int = _CHUNK) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def _is_http_url(url: str) -> bool:
    return urlparse(url).scheme.lower() in {"http", "https"}


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise DownloadError(
            "Dataset source must be an absolute http(s) URL.",
            detail=f"got scheme={parsed.scheme!r}",
        )
    if not parsed.netloc:
        raise DownloadError("Dataset source URL has no host.", detail=url)


def _assert_zip(path: Path) -> None:
    if not path.is_file():
        raise ArchiveError("Downloaded archive is missing.", detail=str(path))
    if path.stat().st_size < 1024:
        raise ArchiveError(
            "Downloaded archive is empty or truncated.",
            detail=f"{path.stat().st_size} bytes",
        )
    if not zipfile.is_zipfile(path):
        raise ArchiveError(
            "Dataset download did not return a zip archive. The source may be "
            "returning an HTML error page instead of the dataset.",
            detail=str(path),
        )


def _safe_members(archive: zipfile.ZipFile, limit: int = 200_000) -> list[zipfile.ZipInfo]:
    """Reject absolute paths and ``..`` traversal (zip-slip)."""
    safe: list[zipfile.ZipInfo] = []
    for info in archive.infolist():
        if info.is_dir():
            continue
        name = info.filename
        normalised = name.replace("\\", "/")
        if normalised.startswith("/") or ".." in Path(normalised).parts:
            raise ArchiveError(
                "Archive contains an unsafe path; refusing to extract.",
                detail=name,
            )
        if len(safe) >= limit:
            raise ArchiveError("Archive contains an implausible number of files.", detail=name)
        safe.append(info)
    return safe


def _extract(archive_path: Path, destination: Path) -> int:
    """Extract ``archive_path``; unwrap single-entry nested zips.

    Returns the number of nested archives that were unwrapped.
    """
    ensure_dir(destination)
    unwrapped = 0
    current = archive_path

    for _ in range(_MAX_NESTING + 1):
        try:
            handle = zipfile.ZipFile(current)
        except zipfile.BadZipFile as exc:
            raise ArchiveError("Archive could not be opened as a zip.", detail=str(exc)) from exc

        with handle as archive:
            members = _safe_members(handle)
            if not members:
                raise ArchiveError("Archive contains no files.", detail=str(current))

            nested = [
                m
                for m in members
                if len(members) == 1 and m.filename.lower().endswith(".zip")
            ]
            if nested:
                current = destination / "nested.zip"
                with handle.open(nested[0]) as src, current.open("wb") as dst:
                    shutil.copyfileobj(src, dst, _CHUNK)
                unwrapped += 1
                log.info("Unwrapping nested archive %s", nested[0].filename)
                continue

            for member in members:
                target = destination / Path(member.filename)
                ensure_dir(target.parent)
                with handle.open(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst, _CHUNK)
            return unwrapped

    raise ArchiveError("Nested archive depth limit exceeded while extracting.")


def _locate_class_tree(root: Path, config: DatasetConfig) -> Path:
    """Find the directory that directly contains the configured part folders."""
    expected = {p.lower(): p for p in config.parts}
    candidates = [root, *sorted(p for p in root.rglob("*") if p.is_dir())]
    for candidate in candidates:
        if not candidate.is_dir():
            continue
        present = {child.name.lower() for child in candidate.iterdir() if child.is_dir()}
        if expected.keys() <= present:
            return candidate
    if config.root_dir:
        direct = root / config.root_dir
        if direct.is_dir():
            return direct
    raise ArchiveError(
        "Could not locate the class tree inside the extracted archive. Expected "
        f"a directory containing {list(config.parts)}.",
        detail=f"searched under {root}",
    )


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def archive_cache_path(config: DatasetConfig | None = None) -> Path:
    cfg = config or dataset_config()
    return dataset_downloads_dir() / f"{cfg.name}-v{cfg.version}.zip"


def is_downloaded(config: DatasetConfig | None = None) -> bool:
    """True when a validated extraction is already on disk (idempotency)."""
    cfg = config or dataset_config()
    return manifest_path(dataset_raw_dir()).is_file()


def download_archive(
    config: DatasetConfig | None = None,
    *,
    force: bool = False,
) -> tuple[Path, str, int]:
    """Fetch the archive, verifying the checksum. Returns (path, sha256, bytes)."""
    cfg = config or dataset_config()
    _validate_url(cfg.source_url)

    target = archive_cache_path(cfg)
    ensure_dir(target.parent)

    if target.is_file() and not force:
        existing = sha256_file(target)
        if cfg.sha256 is None or existing == cfg.sha256:
            log.info("Reusing cached archive %s (%d bytes)", target.name, target.stat().st_size)
            return target, existing, target.stat().st_size
        log.warning(
            "Cached archive %s failed checksum verification; re-downloading.", target.name
        )
        target.unlink()

    last_error: Exception | None = None
    for attempt in range(1, cfg.max_retries + 1):
        partial = target.with_suffix(target.suffix + ".part")
        try:
            log.info(
                "Downloading dataset (attempt %d/%d) from %s",
                attempt,
                cfg.max_retries,
                cfg.source_url,
            )
            ensure_dir(partial.parent)
            size, content_type = _fetch_stream(cfg.source_url, partial, cfg.timeout_seconds)

            if "text/html" in content_type:
                partial.unlink(missing_ok=True)
                raise ArchiveError(
                    "Dataset source returned an HTML page instead of an archive. "
                    "The configured source URL is probably wrong.",
                    detail=f"content-type={content_type}",
                )

            actual = sha256_file(partial)
            # The publisher re-packages the zip on every request, so an archive
            # hash is only enforced when an operator has explicitly pinned one
            # via CITRUSGUARD_DATASET_SHA256. The default path verifies the
            # extracted CONTENT checksum, which is stable for a given build.
            if cfg.sha256 and actual != cfg.sha256:
                partial.unlink(missing_ok=True)
                raise ChecksumMismatchError(
                    "Downloaded archive does not match the pinned checksum "
                    "(CITRUSGUARD_DATASET_SHA256). Clear that variable to accept "
                    "the publisher's current build and verify by content checksum.",
                    detail=f"expected={cfg.sha256} actual={actual}",
                )
            partial.replace(target)
            log.info("Dataset archive ready: %s (%d bytes, sha256=%s)", target, size, actual)
            return target, actual, size

        except ChecksumMismatchError:
            raise  # deterministic: retrying will not help
        except (DownloadError, ArchiveError) as exc:
            partial.unlink(missing_ok=True)
            last_error = exc
        except Exception as exc:  # network/OS errors
            partial.unlink(missing_ok=True)
            last_error = DownloadError(
                "Network error while downloading the dataset.", detail=str(exc)
            )
        if attempt < cfg.max_retries:
            backoff = 2**attempt
            log.warning("Download attempt %d failed (%s); retrying in %ds", attempt, last_error, backoff)
            time.sleep(backoff)

    raise DownloadError(
        "Dataset download failed after "
        f"{cfg.max_retries} attempt(s). Check the configured dataset source URL "
        "and your network connection.",
        detail=str(last_error),
    )


def download_and_extract(
    config: DatasetConfig | None = None,
    *,
    force: bool = False,
) -> DownloadResult:
    """Full acquisition: download -> verify -> extract -> discover -> manifest."""
    cfg = config or dataset_config()
    raw_root = dataset_raw_dir()
    manifest = manifest_path(raw_root)

    if manifest.is_file() and not force:
        log.info("Dataset already prepared at %s; skipping download.", raw_root)
        archive = archive_cache_path(cfg)
        checksum = sha256_file(archive) if archive.is_file() else ""
        return DownloadResult(
            archive_path=archive,
            checksum=checksum,
            bytes_downloaded=archive.stat().st_size if archive.is_file() else 0,
            reused=True,
            extracted_path=raw_root,
            unwrapped=0,
        )

    archive_path, checksum, size = download_archive(cfg, force=force)
    _assert_zip(archive_path)

    staging = dataset_downloads_dir() / "_extracted"
    if staging.exists():
        shutil.rmtree(staging)
    ensure_dir(staging)
    unwrapped = _extract(archive_path, staging)

    class_tree = _locate_class_tree(staging, cfg)
    if raw_root.exists():
        shutil.rmtree(raw_root)
    ensure_dir(raw_root.parent)
    shutil.copytree(class_tree, raw_root)

    # Detected rather than assumed - this is what populates `classes`.
    discovered = discover_layout(raw_root, cfg)
    if not discovered.classes:
        raise ArchiveError(
            "No class folders were found in the extracted dataset.", detail=str(raw_root)
        )
    # Fail loudly here rather than training on a half-extracted tree.
    problems: list[str] = []
    if discovered.corrupt:
        problems.append(
            f"{len(discovered.corrupt)} corrupted image(s), e.g. {discovered.corrupt[0]['path']}"
        )
    if discovered.unsupported:
        problems.append(
            f"{len(discovered.unsupported)} unsupported file(s), e.g. "
            f"{discovered.unsupported[0]['path']}"
        )
    if problems:
        raise ValidationError(
            "Dataset validation failed after extraction. " + "; ".join(problems),
            detail="; ".join(problems),
        )

    write_manifest(
        raw_root,
        cfg,
        discovered,
        extra={
            "source_archive": str(archive_path),
            "archive_sha256": checksum,
            "archive_bytes": size,
            "nested_archives_unwrapped": unwrapped,
        },
    )
    log.info(
        "Dataset prepared: %d images, %d classes across parts %s",
        discovered.total_images,
        len(discovered.classes),
        list(discovered.by_part.keys()),
    )
    return DownloadResult(
        archive_path=archive_path,
        checksum=checksum,
        bytes_downloaded=size,
        reused=False,
        extracted_path=raw_root,
        unwrapped=unwrapped,
    )
