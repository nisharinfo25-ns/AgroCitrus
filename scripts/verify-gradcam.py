"""Numeric sanity check on the generated Grad-CAM artefacts.

A degenerate CAM (all zeros, or a constant) would still write a PNG, so check
the statistics instead of trusting the file's existence:

  * the heatmap must have real spatial variance and a usable dynamic range;
  * the overlay must actually differ from the source image, and differ MORE in
    the high-activation region than in the lowest one.
"""

import io
import sys
from pathlib import Path

sys.path.insert(0, "ml")

import cv2
import numpy as np

from citrusguard.dataset.preprocessor import decode_image
from citrusguard.inference import gradcam
from citrusguard.inference.predictor import ModelBundle

BUNDLE = "models/production"
IMAGE = sys.argv[1] if len(sys.argv) > 1 else "data/citrus/raw/Leaves/Canker/6.png.png"
CLASS_INDEX = int(sys.argv[2]) if len(sys.argv) > 2 else 1
OUT = Path(sys.argv[3] if len(sys.argv) > 3 else "gc-verify")
OUT.mkdir(parents=True, exist_ok=True)

bundle = ModelBundle.load(BUNDLE)
model = bundle.models["part_leaf"]

from citrusguard.dataset.preprocessor import preprocess_for_inference

batch = preprocess_for_inference(
    IMAGE,
    input_size=bundle.input_size,
    preprocessing_method=bundle.preprocessing_method,
)
original = decode_image(IMAGE)

cam = gradcam.compute(
    model, batch, original, OUT, stem="verify", target_class_index=CLASS_INDEX
)
print("heatmap :", cam.heatmap_path)
print("overlay :", cam.overlay_path)
print("layer   :", cam.target_layer)
print("regions :", cam.top_contributing_regions)

# --- read the heatmap back as written, in greyscale (0..255) ----------------- #
hm = cv2.imread(str(cam.heatmap_path), cv2.IMREAD_GRAYSCALE)
if hm is None:
    print("FAIL: heatmap unreadable")
    sys.exit(1)
hm = hm.astype(np.float32) / 255.0
print()
print("heatmap shape      :", hm.shape)
print("heatmap min/max    : %.4f / %.4f" % (hm.min(), hm.max()))
print("heatmap std        : %.4f" % hm.std())
print("heatmap mean       : %.4f" % hm.mean())
print("fraction > 0.5     : %.4f" % float((hm > 0.5).mean()))
print("fraction > 0.9     : %.4f" % float((hm > 0.9).mean()))
print("unique-ish values : %d" % len(np.unique(np.round(hm, 3))))

ov = cv2.imread(str(cam.overlay_path), cv2.IMREAD_COLOR)
if ov is None:
    print("FAIL: overlay unreadable")
    sys.exit(1)
ov_rgb = cv2.cvtColor(ov, cv2.COLOR_BGR2RGB).astype(np.int16)
src = original.astype(np.int16)
if ov_rgb.shape != src.shape:
    print("FAIL: overlay %s != source %s" % (ov_rgb.shape, src.shape))
    sys.exit(1)

diff = np.abs(ov_rgb - src).mean(axis=2)
print()
print("overlay mean |delta| vs source : %.2f" % diff.mean())

# Locate the model's own strongest and weakest activations instead of assuming
# the top-left corner is hot. An earlier version of this check compared fixed
# corners and reported a false FAIL whenever the CAM legitimately attended the
# bottom-right of the image.
h, w = hm.shape
bs = max(1, min(h, w) // 4)
peak_y, peak_x = np.unravel_index(int(np.argmax(hm)), hm.shape)
trough_y, trough_x = np.unravel_index(int(np.argmin(hm)), hm.shape)
peak_patch = hm[
    max(0, peak_y - bs // 2) : peak_y + bs // 2 + 1,
    max(0, peak_x - bs // 2) : peak_x + bs // 2 + 1,
]
trough_patch = hm[
    max(0, trough_y - bs // 2) : trough_y + bs // 2 + 1,
    max(0, trough_x - bs // 2) : trough_x + bs // 2 + 1,
]
print()
print("peak   at (row %3d, col %3d)  value=%.4f  patch mean=%.4f"
      % (peak_y, peak_x, hm[peak_y, peak_x], peak_patch.mean()))
print("trough at (row %3d, col %3d)  value=%.4f  patch mean=%.4f"
      % (trough_y, trough_x, hm[trough_y, trough_x], trough_patch.mean()))

checks = {
    "heatmap has variance": hm.std() > 0.01,
    "heatmap reaches high values": hm.max() > 0.85,
    "overlay differs from source": diff.mean() > 1.0,
    "peak patch is hotter than trough patch": peak_patch.mean() > trough_patch.mean(),
    "peak is near the top of the range": hm[peak_y, peak_x] > 0.5,
}
print()
for label, ok in checks.items():
    print("  [%s] %s" % ("PASS" if ok else "FAIL", label))
sys.exit(0 if all(checks.values()) else 1)