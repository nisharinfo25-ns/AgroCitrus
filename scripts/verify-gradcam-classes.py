"""Prove the Grad-CAM is actually class-targeted.

`target_index` used to be `int(np.argmax(model.output.shape[-1]))` - an argmax
over the class COUNT, i.e. always 0 - so every overlay explained "Black Spot".

If the fix is real, asking for two different classes on the SAME image must
produce two visibly different CAMs, and asking for the same class twice must be
deterministic.
"""

import sys
from pathlib import Path

sys.path.insert(0, "ml")

import cv2
import numpy as np

from citrusguard.dataset.preprocessor import decode_image, preprocess_for_inference
from citrusguard.inference import gradcam
from citrusguard.inference.predictor import ModelBundle

IMAGE = "data/citrus/raw/Leaves/Canker/6.png.png"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "gc-class")
OUT.mkdir(parents=True, exist_ok=True)

bundle = ModelBundle.load("models/production")
model = bundle.models["part_leaf"]
classes = bundle.classes_for("part_leaf")
print("leaf classes:", classes)
print()

batch = preprocess_for_inference(
    IMAGE,
    input_size=bundle.input_size,
    preprocessing_method=bundle.preprocessing_method,
)
original = decode_image(IMAGE)

maps = {}
for index, name in enumerate(classes):
    cam = gradcam.compute(
        model, batch, original, OUT, stem="cls%d" % index, target_class_index=index
    )
    hm = cv2.imread(cam.heatmap_path, cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255.0
    maps[index] = (name, hm, hm.mean(), hm.max())

# Determinism: recompute class 1 and compare.
cam_again = gradcam.compute(
    model, batch, original, OUT, stem="again", target_class_index=1
)
again = cv2.imread(cam_again.heatmap_path, cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255.0
print("determinism (same class twice) max|delta| : %.6f" % np.abs(again - maps[1][1]).max())
print()
for index, (name, hm, mean, peak) in maps.items():
    print("  %-26s mean=%.4f peak=%.4f" % (name, mean, peak))
print()

print("pairwise mean |delta| between class CAMs:")
keys = sorted(maps)
distinct = 0
pairs = 0
for i in range(len(keys)):
    for j in range(i + 1, len(keys)):
        a, b = maps[keys[i]][1], maps[keys[j]][1]
        delta = float(np.abs(a - b).mean())
        pairs += 1
        if delta > 0.01:
            distinct += 1
        print(
            "  %-26s vs %-26s %.4f %s"
            % (maps[keys[i]][0], maps[keys[j]][0], delta, "" if delta > 0.01 else "<-- IDENTICAL")
        )
print()
print("distinct CAMs: %d of %d pairs" % (distinct, pairs))
sys.exit(0 if distinct == pairs else 1)