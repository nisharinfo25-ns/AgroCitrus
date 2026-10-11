import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ML_DIR = path.join(ROOT, "ml");

/**
 * Python-side invariants that the TypeScript suite cannot see.
 *
 * Each guards a bug that actually shipped in this project and produced a
 * silently wrong model rather than an error:
 *
 *   1. `scale_for_model` must give identical results on a NumPy array and on an
 *      `EagerTensor` inside `tf.data`. A NumPy-only implementation raises
 *      `AttributeError: EagerTensor has no attribute 'astype'` the first time a
 *      pipeline touches it, which is why it is built from Keras layers.
 *
 *   2. The MobileNetV2 path must actually apply the ImageNet normalisation. A
 *      `Normalization` layer alone skips the /255 and feeds the backbone values
 *      in the hundreds (observed max 1136 instead of ~2.6).
 *
 *   3. `train.normalize_for_model` must delegate rather than reimplement, or
 *      training and inference can drift apart with nothing to catch it.
 *
 * Everything runs in a single interpreter. Importing TensorFlow costs ~10-90s
 * depending on load, so one subprocess is the difference between a usable test
 * and a five-minute one.
 *
 * Skipped, loudly, when the Python package is absent: a missing interpreter is
 * an environment problem, and failing here would be a false alarm that trains
 * the reader to ignore the suite.
 */
const PYTHON = process.platform === "win32" ? "python" : "python3";
const hasPackage = existsSync(path.join(ML_DIR, "citrusguard", "dataset", "preprocessor.py"));
const describePython = hasPackage ? describe : describe.skip;

if (!hasPackage) {
  console.warn("[preprocessing] skipped: no Python package at ml/citrusguard");
}

interface Parity {
  max_abs_diff: number;
  shape: number[];
  imagenet_min: number;
  imagenet_max: number;
  unit: number[];
  delegates: boolean;
  reimplements_with_numpy: boolean;
  classes: string[];
}

describePython("ML preprocessing invariants", () => {
  let report: Parity;

  beforeAll(async () => {
    const { stdout } = await run(
      PYTHON,
      [
        "-c",
        `
import inspect, json
import numpy as np
import tensorflow as tf

from citrusguard.dataset.preprocessor import scale_for_model, SCALING_METHODS
from citrusguard.training import train

rng = np.random.default_rng(1337)
x = rng.integers(0, 256, size=(2, 8, 8, 3), dtype=np.uint8)

# 1. NumPy in, EagerTensor in, identical out.
as_numpy = np.asarray(scale_for_model(x, "mobilenet_v2_imagenet"))
as_tensor = scale_for_model(tf.constant(x), "mobilenet_v2_imagenet").numpy()

# 2. A fully saturated image is the worst case for a missing /255.
saturated = np.full((1, 16, 16, 3), 255, dtype=np.uint8)
scaled = np.asarray(scale_for_model(saturated, "mobilenet_v2_imagenet"))

# 3. The unit method is a plain Rescaling(1/255).
triple = np.array([[[[0, 128, 255]]]], dtype=np.uint8)
unit = np.asarray(scale_for_model(triple, "unit")).ravel()

# 4. The training loop must not reimplement the maths.
body = inspect.getsource(train.normalize_for_model)

print(json.dumps({
    "max_abs_diff": float(np.max(np.abs(as_numpy - as_tensor))),
    "shape": list(as_numpy.shape),
    "imagenet_min": float(scaled.min()),
    "imagenet_max": float(scaled.max()),
    "unit": [float(v) for v in unit],
    "delegates": "scale_for_model" in body,
    "reimplements_with_numpy": "astype" in body,
    "classes": list(SCALING_METHODS),
}))
`,
      ],
      {
        cwd: ML_DIR,
        env: { ...process.env, PYTHONPATH: ".", TF_CPP_MIN_LOG_LEVEL: "3" },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 300_000,
      },
    );
    report = JSON.parse(stdout.trim()) as Parity;
  }, 300_000);

  it("preserves the input shape", () => {
    expect(report.shape).toEqual([2, 8, 8, 3]);
  });

  it("scales a NumPy array and an EagerTensor identically", () => {
    // A divergence here is train/serve skew. This must be bit-equal in practice,
    // not merely close: the two paths feed the same network.
    expect(report.max_abs_diff).toBeLessThan(1e-5);
  });

  it("keeps the MobileNetV2 path inside the ImageNet input range", () => {
    // ImageNet mean/std normalisation of 255 lands near [-2.1, 2.6]. The
    // regressed version (Normalization without the preceding Rescaling)
    // produced values in the hundreds.
    expect(report.imagenet_min).toBeGreaterThan(-5);
    expect(report.imagenet_max).toBeLessThan(5);
  });

  it("maps uint8 through the unit method as x/255", () => {
    // The unit method is a plain Rescaling(1/255), so the range is [0, 1] - not
    // [-1, 1]. Asserted explicitly because the two are easy to confuse and a
    // change here silently shifts every input by half a range.
    expect(report.unit[0]).toBeCloseTo(0, 6);
    expect(report.unit[1]).toBeCloseTo(128 / 255, 6);
    expect(report.unit[2]).toBeCloseTo(1, 6);
  });

  it("has the training loop delegate to the shared scaler", () => {
    // If training reimplements the maths the two can drift apart silently.
    expect(report.delegates).toBe(true);
    expect(report.reimplements_with_numpy).toBe(false);
  });

  it("registers exactly the documented scaling methods", () => {
    // An unregistered method would fail at inference time, on a user's upload,
    // rather than here.
    expect(report.classes).toEqual(["mobilenet_v2_imagenet", "imagenet", "unit"]);
  });
});
