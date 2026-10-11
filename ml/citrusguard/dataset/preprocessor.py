"""Image preprocessing shared by training and inference.

Two entry points, deliberately kept identical so train/serve skew is impossible:

* :func:`preprocess_for_inference` - decode, RGB convert, resize, normalise.
* :func:`build_train_augmenter` - training-split-only geometric/photometric
  augmentation built from ``model.yaml``.

All image I/O goes through OpenCV. A decoded image is always returned as a
float32 array shaped ``(H, W, 3)`` with channels in RGB order.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from ..common.errors import ImageValidationError, PreprocessingError

try:  # pragma: no cover - import guard
    import cv2
except ModuleNotFoundError as exc:  # pragma: no cover
    raise PreprocessingError(
        "OpenCV (opencv-python) is required. Run: pip install -r requirements.txt",
        detail=str(exc),
    ) from exc

_DECODE_FLAGS = cv2.IMREAD_UNCHANGED


def decode_image(source: str | Path | bytes) -> np.ndarray:
    """Decode an image file to an RGB uint8 array.

    Raises :class:`ImageValidationError` for unreadable or non-image input.
    """
    if isinstance(source, (bytes, bytearray)):
        buffer = np.frombuffer(bytes(source), dtype=np.uint8)
        if buffer.size == 0:
            raise ImageValidationError("The uploaded file is empty.")
        image = cv2.imdecode(buffer, _DECODE_FLAGS)
    else:
        path = Path(source)
        if not path.is_file():
            raise ImageValidationError("The uploaded image could not be found.")
        image = cv2.imread(str(path), _DECODE_FLAGS)

    if image is None or image.size == 0:
        raise ImageValidationError(
            "That file could not be read as an image. Please upload a JPEG, PNG "
            "or WebP photo of a citrus fruit or leaf."
        )

    image = to_rgb_uint8(image)
    if image.ndim != 3 or image.shape[2] != 3:
        raise ImageValidationError("Unsupported image format or channel layout.")
    return image


def to_rgb_uint8(image: np.ndarray) -> np.ndarray:
    """Normalise any decoded layout (gray / BGR / BGRA / 16-bit) to RGB uint8."""
    if image.dtype == np.uint16:
        image = (image / 257.0).astype(np.uint8)
    elif image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)

    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)

    channels = image.shape[2]
    if channels == 1:
        return cv2.cvtColor(image[:, :, 0], cv2.COLOR_GRAY2RGB)
    if channels == 3:
        return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    if channels == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2RGB)
    raise ImageValidationError(
        f"Unsupported image channel count: {channels}.",
    )


def resize_rgb(image: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Resize to ``(height, width)`` with a high-quality interpolator."""
    height, width = int(size[0]), int(size[1])
    current_h, current_w = image.shape[:2]
    if (current_h, current_w) == (height, width):
        return image
    # Downscale with INTER_AREA, upscale with INTER_CUBIC.
    interpolation = cv2.INTER_AREA if current_h > height else cv2.INTER_CUBIC
    return cv2.resize(image, (width, height), interpolation=interpolation)


def preprocess_for_inference(
    source: str | Path | bytes,
    *,
    input_size: tuple[int, int],
    preprocessing_method: str = "mobilenet_v2_imagenet",
) -> np.ndarray:
    """Decode -> RGB -> resize -> normalise, returning ``(1, H, W, 3)`` float32.

    The normalisation matches whatever the training run used, so the caller
    should read ``preprocessing_method`` from the exported model config rather
    than assuming a value.
    """
    image = decode_image(source)
    image = resize_rgb(image, input_size)
    normalised = scale_for_model(image, preprocessing_method)
    return np.expand_dims(normalised, axis=0)


def _scaler(preprocessing_method: str) -> Any:
    """Return the (cached) Keras layer that performs the input scaling.

    Implemented as a Keras layer rather than raw NumPy so the *same* object
    serves both callers: Keras layers accept a NumPy array and return one, and
    accept an ``EagerTensor`` inside a ``tf.data`` pipeline and return a tensor
    natively. A NumPy implementation would raise ``AttributeError: EagerTensor
    has no attribute 'astype'`` when the training pipeline called it, forcing a
    second copy of the arithmetic that could silently drift from this one.
    """
    if preprocessing_method not in _SCALERS:
        raise PreprocessingError(
            f"Unknown preprocessing method '{preprocessing_method}'.",
            detail=f"Supported: {', '.join(SCALING_METHODS)}",
        )
    if preprocessing_method not in _SCALER_CACHE:
        _SCALER_CACHE[preprocessing_method] = _SCALERS[preprocessing_method]()
    return _SCALER_CACHE[preprocessing_method]


_SCALER_CACHE: dict[str, Any] = {}


def _mobilenet_scaler() -> Any:
    # MobileNetV2 / EfficientNet expect [-1, 1] from a 0-255 uint8 image.
    from tensorflow import keras

    return keras.layers.Rescaling(scale=1.0 / 127.5, offset=-1.0)


def _imagenet_scaler() -> Any:
    from tensorflow import keras

    # Two steps: uint8 -> [0,1], then standardise. `Normalization` alone would
    # skip the /255 and produce values in the hundreds.
    return keras.Sequential(
        [
            keras.layers.Rescaling(scale=1.0 / 255.0),
            keras.layers.Normalization(
                mean=[0.485, 0.456, 0.406],
                # Normalization divides by sqrt(variance), hence std squared.
                variance=[0.229**2, 0.224**2, 0.225**2],
            ),
        ],
        name="imagenet_scaler",
    )


def _unit_scaler() -> Any:
    from tensorflow import keras

    return keras.layers.Rescaling(scale=1.0 / 255.0)


_SCALERS = {
    "mobilenet_v2_imagenet": _mobilenet_scaler,
    "imagenet": _imagenet_scaler,
    "unit": _unit_scaler,
}

#: Public, ordered list of the accepted ``preprocessing_method`` values.
#: Deriving it from the registry means a new scaler cannot be added without also
#: appearing in the error message, the config validation and the docs.
SCALING_METHODS: tuple[str, ...] = tuple(_SCALERS)


def scale_for_model(images: Any, preprocessing_method: str = "mobilenet_v2_imagenet") -> Any:
    """Scale decoded uint8 images to the range the backbone expects.

    **The single source of truth for input scaling.** Both the training
    pipeline and the inference path call this, which is what makes train/serve
    skew structurally impossible rather than a thing to remember.

    ``preprocess_for_inference`` adds decode + resize on top of it; the training
    pipeline applies augmentation to the uint8 image first and calls this
    afterwards, so the scaling is always the last operation either way.

    Accepts a NumPy array or a ``tf.Tensor`` and returns the matching type, so
    it is safe to call from plain Python and from inside a ``tf.data`` map.
    """
    return _scaler(preprocessing_method)(images)


def normalize_uint8(image: np.ndarray) -> np.ndarray:
    """Plain [0,1] normalisation - used by the image-quality stage, which must
    not depend on the model-specific scaling."""
    return image.astype(np.float32) / 255.0


def build_train_augmenter(config: dict[str, Any]) -> Any:
    """Keras augmentation pipeline for the training split only.

    Returns a ``keras.Sequential`` of ``Random*`` layers (available in
    TF >= 2.6) operating on uint8 ``(H, W, 3)`` tensors, which keeps the
    augmentation on the accelerator and outside the Python generator loop.

    Two augmentation parameters cannot be expressed as separate layers without
    cancelling out, so they are combined:

    * ``width_shift_range`` and ``height_shift_range`` share one
      ``RandomTranslation(height, width)`` call;
    * a zoom range is one ``RandomZoom`` factor. A symmetric
      ``(-z, z)`` interval zooms in and out evenly.
    """
    from tensorflow import keras
    from tensorflow.keras import layers

    aug = config.get("training", {}).get("augmentation", {})

    steps: list[Any] = []
    if aug.get("rotation_range_degrees"):
        # Keras expresses rotation as a fraction of a full turn, not degrees.
        steps.append(layers.RandomRotation(float(aug["rotation_range_degrees"]) / 360.0))
    if aug.get("width_shift_range") or aug.get("height_shift_range"):
        height = float(aug.get("height_shift_range", 0.0))
        width = float(aug.get("width_shift_range", 0.0))
        steps.append(layers.RandomTranslation(height, width))
    if aug.get("zoom_range"):
        z = float(aug["zoom_range"])
        steps.append(layers.RandomZoom(-z, z))
    if aug.get("horizontal_flip"):
        steps.append(layers.RandomFlip("horizontal"))
    if aug.get("brightness_range"):
        low, high = aug["brightness_range"]
        steps.append(layers.RandomBrightness((float(low) - 1.0, float(high) - 1.0)))

    # `layers.Sequential` is not re-exported from `keras.layers` in TF 2.15; the
    # module-level `keras.Sequential` is the supported constructor.
    return keras.Sequential(steps, name="train_augmentation") if steps else None


def preprocessed_copy(source: str | Path | bytes, destination: Path, size: tuple[int, int]) -> Path:
    """Write an RGB, resized copy of the upload (used for the ``processed/``
    folder in the ``scan-images`` bucket)."""
    image = resize_rgb(decode_image(source), size)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # cv2.imwrite expects BGR.
    if not cv2.imwrite(str(destination), cv2.cvtColor(image, cv2.COLOR_RGB2BGR)):
        raise PreprocessingError("Failed to write the processed image.", detail=str(destination))
    return destination
