"""Grad-CAM class activation visualisation.

Implements Grad-CAM (Selvaraju et al., 2017) for the ``part`` and disease
heads. The heatmap is a *localisation aid* - it shows which spatial regions
moved the score for the predicted class. It is not proof of disease and the UI
states that explicitly.

Implementation notes
--------------------
* The target layer is the last convolutional block of the frozen backbone, so
  activations are a 7x7 (MobileNetV2 @224) feature map - which is exactly the
  spatial granularity Grad-CAM is designed for.
* Gradients are taken with respect to the predicted class score and are
  globally average-pooled to produce the channel weights.
* Overlay rendering is done with OpenCV only (no matplotlib in the request
  path), returning both a plain heatmap PNG and a blended overlay PNG.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..common.errors import ModelLoadError

try:  # pragma: no cover
    import cv2
except ModuleNotFoundError:  # pragma: no cover
    cv2 = None  # type: ignore[assignment]


@dataclass
class GradCamResult:
    heatmap_path: str | None
    overlay_path: str | None
    target_layer: str
    top_contributing_regions: list[str]


def _conv_candidates(
    model: Any, prefix: str = "", depth: int = 0
) -> list[tuple[str, Any, Any]]:
    """Every layer whose OUTPUT is a rank-4 convolutional feature map.

    Recurses into nested models: each CitrusGuard head is a Sequential
    whose first layer is a whole MobileNetV2, and the only 4D activations
    live inside it. Returns ``(qualified_name, layer, owning_model)``.
    """
    if depth > 6:  # pragma: no cover - guards a malformed nesting cycle
        return []
    found: list[tuple[str, Any, Any]] = []
    for layer in getattr(model, "layers", []):
        name = f"{prefix}{layer.name}"
        output = getattr(layer, "output", None)
        shape = getattr(output, "shape", None)
        if shape is not None and len(shape) == 4:
            found.append((name, layer, model))
        nested = getattr(layer, "layers", None)
        if nested:
            found.extend(_conv_candidates(layer, f"{name}/", depth + 1))
    return found


def _find_target_layer(model: Any, preferred: str | None) -> tuple[Any, str, Any]:
    """Pick the last conv block: the deepest layer with a 4D output.

    Returns the layer, its name, and the model whose graph owns it - the
    owner is needed to build a sub-model that can be called on the outer
    model's input.
    """
    candidates = _conv_candidates(model)
    if not candidates:
        raise ModelLoadError(
            "Could not locate a convolutional layer for Grad-CAM in this model."
        )
    if preferred:
        for name, layer, owner in candidates:
            if preferred.lower() in name.lower():
                return layer, name, owner
    name, layer, owner = candidates[-1]
    return layer, name, owner

def _build_keras_gradcam(
    model: Any,
    target_layer: Any,
    owner: Any,
    target_class_index: int | None = None,
) -> Any:
    import tensorflow as tf

    # `target_layer.output` cannot be wired into a model built on `model.input`:
    # the layer lives inside a nested backbone, so its symbolic tensor belongs to
    # that backbone's graph. Work inside the owner's graph instead - take the
    # owner's input and ask that one graph for the activation and its own output
    # together.
    owner_inputs = getattr(owner, "inputs", None)
    if not owner_inputs:
        raise ModelLoadError(
            "Could not determine the input of the model that owns the Grad-CAM "
            "target layer.",
            detail=f"owner={getattr(owner, 'name', owner)!r}",
        )
    if isinstance(owner_inputs, list):
        owner_inputs = owner_inputs[0]
    # One pass through the backbone, exposing BOTH the target activation and the
    # backbone's own output. Asking one graph for two outputs is what keeps the
    # activation connected to the prediction: running the truncated backbone
    # separately produced two independent branches, so the loss had no path to
    # the activations and `tape.gradient(loss, activations)` was None.
    backbone_tap = tf.keras.Model(
        inputs=owner_inputs, outputs=[target_layer.output, owner.output]
    )
    head_layers = [
        layer for layer in getattr(model, "layers", []) if layer is not owner
    ]
    if not head_layers:
        raise ModelLoadError(
            "Could not locate the classifier head that follows the Grad-CAM "
            "backbone.",
            detail=f"model={model.name!r} owner={owner.name!r}",
        )

    class _TappedBranch(tf.keras.Model):
        """Backbone once (yielding activation + pooled features), then the
        classifier head. Everything is produced inside the caller's tape."""

        def call(self, inputs):
            activations, features = backbone_tap(inputs)
            predictions = features
            for layer in head_layers:
                predictions = layer(predictions)
            return predictions, activations

    tapped = _TappedBranch()
    # The caller knows which class won. This used to be
    # `int(np.argmax(model.output.shape[-1]))` - an argmax over the class
    # COUNT, which is always 0 - so every overlay explained class 0
    # ("Black Spot") instead of the class the model actually predicted.
    n_classes = int(model.output.shape[-1])
    if target_class_index is None or not (0 <= int(target_class_index) < n_classes):
        raise ModelLoadError(
            "Grad-CAM was asked to explain a class index that this model does "
            "not have.",
            detail=f"target_class_index={target_class_index!r}, n_classes={n_classes}",
        )
    target_index = int(target_class_index)

    def generate(input_tensor):
        with tf.GradientTape() as tape:
            tape.watch(input_tensor)
            predictions, activations = tapped(input_tensor)
            loss = predictions[:, target_index]
        grads = tape.gradient(loss, activations)
        if grads is None:
            raise ModelLoadError(
                "Grad-CAM could not reach the target activations.",
                detail=f"target layer {target_layer.name!r} yielded no gradient",
            )
        # Global average pool the gradients -> per-channel weights.
        pooled = tf.reduce_mean(grads, axis=(1, 2))
        # Channels-last: `activations` is (N, H, W, C), so the (N, C) weights
        # broadcast as (N, 1, 1, C). `pooled[:, :, None, None]` produced
        # (N, C, 1, 1) - a channels-FIRST layout - and raised
        # `Incompatible shapes: [1,1280,1,1] vs. [1,7,7,1280]`.
        weights = pooled[:, None, None, :]
        cam = tf.reduce_sum(weights * activations, axis=1)
        cam = tf.nn.relu(cam)
        # Scale each sample to [0, 1].
        denom = tf.reduce_max(cam, axis=(1, 2), keepdims=True) + 1e-7
        return cam / denom, predictions, target_index

    return generate


def compute(
    model: Any,
    input_batch: np.ndarray,
    original_image: np.ndarray,
    output_dir: Path,
    *,
    stem: str = "gradcam",
    target_layer_name: str | None = None,
    target_class_index: int | None = None,
) -> GradCamResult:
    """Render Grad-CAM artefacts for the model's current top class.

    ``input_batch`` must already be preprocessed to the model's input shape.
    ``original_image`` is the decoded RGB uint8 image the user uploaded and is
    used as the overlay background.
    """
    if cv2 is None:  # pragma: no cover
        raise ModelLoadError("OpenCV is required to render Grad-CAM overlays.")

    import tensorflow as tf

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    layer, layer_name, owner = _find_target_layer(model, target_layer_name)
    generate = _build_keras_gradcam(model, layer, owner, target_class_index)

    heatmaps, predictions, target_index = generate(tf.convert_to_tensor(input_batch, tf.float32))
    heatmap = np.asarray(heatmaps)[0]
    probs = np.asarray(predictions)[0]

    heatmap_path = output_dir / f"{stem}-heatmap.png"
    overlay_path = output_dir / f"{stem}-overlay.png"

    # Upsample the low-res CAM to the original image size.
    height, width = original_image.shape[:2]
    upsampled = cv2.resize(heatmap, (width, height), interpolation=cv2.INTER_CUBIC)
    upsampled = np.clip(upsampled, 0.0, 1.0)

    # Apply a colormap, then blend with the source image.
    heatmap_bgr = cv2.applyColorMap(
        np.uint8(255 * upsampled), cv2.COLORMAP_JET
    )
    heatmap_rgb = cv2.cvtColor(heatmap_bgr, cv2.COLOR_BGR2RGB)
    cv2.imwrite(str(heatmap_path), cv2.cvtColor(heatmap_rgb, cv2.COLOR_RGB2BGR))

    alpha = 0.45
    overlay = (
        original_image.astype(np.float32) * (1.0 - alpha)
        + heatmap_rgb.astype(np.float32) * alpha
    )
    cv2.imwrite(str(overlay_path), cv2.cvtColor(np.clip(overlay, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR))

    return GradCamResult(
        heatmap_path=str(heatmap_path),
        overlay_path=str(overlay_path),
        target_layer=layer_name,
        top_contributing_regions=_describe_regions(upsampled),
    )


def _describe_regions(heatmap: np.ndarray, top: int = 3) -> list[str]:
    """Human-readable location of the strongest activation (e.g. 'centre')."""
    height, width = heatmap.shape[:2]
    flat = np.argsort(heatmap.ravel())[::-1][: top * 40]
    points = [(int(i % width), int(i // width)) for i in flat]
    if not points:
        return []

    cx, cy = width / 2.0, height / 2.0
    labels: list[tuple[str, float]] = []
    for x, y in points:
        dx, dy = (x - cx) / cx, (y - cy) / cy
        if abs(dx) < 0.33 and abs(dy) < 0.33:
            label = "centre of the subject"
        elif abs(dx) >= abs(dy):
            label = "right side of the image" if dx > 0 else "left side of the image"
        else:
            label = "lower part of the image" if dy > 0 else "upper part of the image"
        labels.append((label, 0.0))

    ordered: list[str] = []
    for label, _ in labels:
        if label not in ordered:
            ordered.append(label)
        if len(ordered) == top:
            break
    return ordered


def format_regions(regions: list[str]) -> str:
    if not regions:
        return "No dominant region could be determined for this prediction."
    if len(regions) == 1:
        return f"The model focused mainly on the {regions[0]}."
    joined = ", ".join(regions[:-1]) + f" and {regions[-1]}"
    return f"The model focused mainly on the {joined}."
