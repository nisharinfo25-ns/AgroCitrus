"""Typed error hierarchy.

Every error carries a stable ``code`` so the HTTP layer can map it onto a
user-safe message without ever leaking a traceback to the browser. Technical
detail goes to the server log via :func:`citrusguard.common.logging.get_logger`.
"""

from __future__ import annotations


class CitrusGuardError(Exception):
    """Base class for every error raised by the pipeline."""

    code = "citrusguard_error"
    http_status = 500

    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "detail": self.detail}


class ConfigError(CitrusGuardError):
    code = "config_invalid"
    http_status = 500


class DownloadError(CitrusGuardError):
    """The configured dataset source could not be retrieved."""

    code = "dataset_download_failed"
    http_status = 502


class ChecksumMismatchError(DownloadError):
    code = "dataset_checksum_mismatch"


class ArchiveError(CitrusGuardError):
    """The downloaded archive is not a readable, expected zip."""

    code = "dataset_archive_invalid"
    http_status = 502


class ValidationError(CitrusGuardError):
    """The dataset on disk failed validation."""

    code = "dataset_validation_failed"
    http_status = 422


class PreprocessingError(CitrusGuardError):
    code = "preprocessing_failed"
    http_status = 422


class ModelNotConfiguredError(CitrusGuardError):
    """No production model artifact is available. Never faked."""

    code = "model_not_configured"
    http_status = 503


class ModelLoadError(CitrusGuardError):
    code = "model_load_failed"
    http_status = 500


class ImageValidationError(CitrusGuardError):
    """The uploaded file is not a usable image."""

    code = "image_invalid"
    http_status = 422


class ImageQualityError(CitrusGuardError):
    """The image decodes but is too poor to predict from."""

    code = "image_quality_insufficient"
    http_status = 422


class PredictionError(CitrusGuardError):
    code = "prediction_failed"
    http_status = 500


class StorageError(CitrusGuardError):
    code = "storage_failed"
    http_status = 502


class UnauthorizedError(CitrusGuardError):
    code = "unauthorized"
    http_status = 401


class AdminRequiredError(CitrusGuardError):
    code = "admin_required"
    http_status = 403
