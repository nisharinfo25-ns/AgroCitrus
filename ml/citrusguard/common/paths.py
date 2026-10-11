"""Shared helpers: logging, filesystem layout and environment loading."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

_CONFIGURED = False


def get_logger(name: str = "citrusguard") -> logging.Logger:
    """Return a module logger with a single stderr handler attached."""
    global _CONFIGURED
    if not _CONFIGURED:
        handler = logging.StreamHandler(stream=sys.stderr)
        handler.setFormatter(
            logging.Formatter(
                fmt="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
                datefmt="%H:%M:%S",
            )
        )
        root = logging.getLogger("citrusguard")
        root.setLevel(os.getenv("CITRUSGUARD_LOG_LEVEL", "INFO").upper())
        root.addHandler(handler)
        root.propagate = False
        _CONFIGURED = True
    return logging.getLogger(name if name.startswith("citrusguard") else f"citrusguard.{name}")


def project_root() -> Path:
    """Repository root, i.e. the directory that contains ``ml/``.

    ``CITRUSGUARD_PROJECT_ROOT`` overrides detection, which is what the web app
    does when it spawns the worker with an explicit working directory.
    """
    override = os.getenv("CITRUSGUARD_PROJECT_ROOT")
    if override:
        return Path(override).resolve()
    # .../<repo>/ml/citrusguard/common/paths.py -> parents[3] == <repo>
    return Path(__file__).resolve().parents[3]


def _resolve_dir(env_var: str, default: str) -> Path:
    raw = os.getenv(env_var, default)
    path = Path(raw)
    if not path.is_absolute():
        path = project_root() / path
    return path.resolve()


def data_root() -> Path:
    """Local (git-ignored) dataset cache: ``<repo>/data``."""
    return _resolve_dir("CITRUSGUARD_DATA_DIR", "data")


def dataset_raw_dir() -> Path:
    return data_root() / "citrus" / "raw"


def dataset_processed_dir() -> Path:
    return data_root() / "citrus" / "processed"


def dataset_downloads_dir() -> Path:
    return data_root() / "citrus" / "downloads"


def split_dir(part: str, split: str) -> Path:
    """``data/citrus/processed/<part>/<split>/<class>/<image>``."""
    return dataset_processed_dir() / part.lower() / split


def models_root() -> Path:
    return _resolve_dir("CITRUSGUARD_MODEL_DIR", "models")


def reports_root() -> Path:
    return _resolve_dir("CITRUSGUARD_REPORT_DIR", "reports")


def model_cache_dir() -> Path:
    """Where the Next.js server caches the production artifact pulled from
    Supabase Storage. Ephemeral by design - rehydrated on cold start."""
    raw = os.getenv("CITRUSGUARD_MODEL_CACHE_DIR", ".cache/citrusguard/models")
    path = Path(raw)
    if not path.is_absolute():
        path = project_root() / path
    return path.resolve()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_dotenv_if_present() -> None:
    """Load ``.env.local`` / ``.env`` from the repo root if python-dotenv is
    available. Never overrides variables that are already set."""
    try:
        from dotenv import load_dotenv
    except ModuleNotFoundError:  # pragma: no cover - optional dependency
        return
    root = project_root()
    for name in (".env.local", ".env"):
        candidate = root / name
        if candidate.is_file():
            load_dotenv(candidate, override=False)
