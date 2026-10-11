"""YAML configuration loading with environment overrides.

Precedence (highest first): explicit kwargs > environment > YAML file > default.
Keeping every tunable in one place means the web app, the CLI and the tests all
observe identical settings.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..common.errors import ConfigError
from ..common.paths import get_logger

try:  # pragma: no cover - exercised implicitly
    import yaml
except ModuleNotFoundError as exc:  # pragma: no cover
    raise ConfigError("PyYAML is required. Run: pip install -r requirements.txt") from exc

log = get_logger("config")

CONFIG_DIR = Path(__file__).resolve().parent


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _coerce(raw: str) -> Any:
    """Convert an env string to int/float/bool/None when it obviously is one."""
    lowered = raw.strip().lower()
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    if lowered in {"", "null", "none"}:
        return None if lowered != "" else ""
    for caster in (int, float):
        try:
            return caster(raw)
        except ValueError:
            continue
    return raw


@dataclass(frozen=True)
class DatasetConfig:
    name: str
    version: str
    source_url: str
    landing_page: str
    doi: str
    license: str
    license_url: str
    attribution: str
    sha256: str | None
    root_dir: str
    parts: tuple[str, ...]
    ignore_names: tuple[str, ...]
    allowed_extensions: tuple[str, ...]
    min_file_bytes: int
    min_images_per_class: int
    max_retries: int
    timeout_seconds: int
    storage_bucket: str
    storage_prefix: str

    def to_metadata(self) -> dict[str, Any]:
        """Shape consumed by the Supabase ``dataset_metadata`` upsert."""
        return {
            "dataset_name": self.name,
            "source_url": self.source_url,
            "landing_page": self.landing_page,
            "version": self.version,
            "license": self.license,
            "license_url": self.license_url,
            "attribution": self.attribution,
            "doi": self.doi,
        }


def _load_yaml(path: Path) -> dict:
    if not path.is_file():
        raise ConfigError(f"Configuration file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ConfigError(f"Configuration file must contain a mapping: {path}")
    return data


@lru_cache(maxsize=1)
def dataset_config() -> DatasetConfig:
    raw = _load_yaml(CONFIG_DIR / "dataset.yaml")["dataset"]
    raw = _deep_merge(raw, _env_overrides())

    source_url = str(raw["source_url"]).strip()
    if not source_url.lower().startswith(("http://", "https://")):
        raise ConfigError(
            "dataset.source_url must be an absolute http(s) URL. The dataset "
            "source is explicitly configured - it is never guessed.",
            detail=source_url,
        )
    parts = tuple(str(p) for p in raw.get("parts", ()))
    if not parts:
        raise ConfigError("dataset.parts must list at least one image category.")

    checksum = raw.get("sha256") or None
    if checksum is not None:
        checksum = str(checksum).strip().lower() or None

    return DatasetConfig(
        name=str(raw["name"]),
        version=str(raw["version"]),
        source_url=source_url,
        landing_page=str(raw.get("landing_page", "")),
        doi=str(raw.get("doi", "")),
        license=str(raw.get("license", "")),
        license_url=str(raw.get("license_url", "")),
        attribution=str(raw.get("attribution", "")).strip(),
        sha256=checksum,
        root_dir=str(raw.get("root_dir", "")),
        parts=parts,
        ignore_names=tuple(str(n) for n in raw.get("ignore_names", ())),
        allowed_extensions=tuple(
            str(e).lower() for e in raw.get("allowed_extensions", (".jpg", ".jpeg", ".png"))
        ),
        min_file_bytes=int(raw.get("min_file_bytes", 1024)),
        min_images_per_class=int(raw.get("min_images_per_class", 1)),
        max_retries=int(raw.get("max_retries", 3)),
        timeout_seconds=int(raw.get("timeout_seconds", 300)),
        storage_bucket=str(raw.get("storage_bucket", "citrus-dataset")),
        storage_prefix=str(raw.get("storage_prefix", "")).strip("/"),
    )


def _env_overrides() -> dict:
    mapping = {
        "source_url": "CITRUSGUARD_DATASET_URL",
        "landing_page": "CITRUSGUARD_DATASET_LANDING_PAGE",
        "name": "CITRUSGUARD_DATASET_NAME",
        "version": "CITRUSGUARD_DATASET_VERSION",
        "sha256": "CITRUSGUARD_DATASET_SHA256",
        "max_retries": "CITRUSGUARD_DATASET_MAX_RETRIES",
    }
    out: dict[str, Any] = {}
    for key, env_name in mapping.items():
        if env_name in os.environ:
            out[key] = _coerce(os.environ[env_name])
    return out


@lru_cache(maxsize=1)
def model_config() -> dict:
    """Return the full model configuration mapping (mutable copy per call)."""
    raw = _load_yaml(CONFIG_DIR / "model.yaml")

    threshold = os.getenv("CITRUSGUARD_MIN_CONFIDENCE")
    if threshold:
        try:
            raw["inference"]["min_confidence"] = float(threshold)
        except ValueError as exc:
            raise ConfigError(
                "CITRUSGUARD_MIN_CONFIDENCE must be a number between 0 and 1.",
                detail=threshold,
            ) from exc
    log.debug(
        "model config loaded: architecture=%s min_confidence=%s",
        raw["model"]["architecture"],
        raw["inference"]["min_confidence"],
    )
    return raw
