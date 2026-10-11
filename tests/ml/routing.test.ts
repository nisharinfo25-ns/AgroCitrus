import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ML_DIR = path.join(ROOT, "ml");

/**
 * Guards the two inference bugs that made the first version of this pipeline
 * quietly wrong, plus the trained stage-1 router that replaced the heuristic
 * which caused one of them.
 *
 *   1. DOUBLE SOFTMAX. `predict_image` used to apply `softmax()` to the head's
 *      output even when the head already ended in a softmax, squashing an
 *      already-normalised distribution a second time. The guard below builds a
 *      real Keras model with a softmax head and asserts `_predict_probs` returns
 *      it UNCHANGED, and a second model without one and asserts softmax is
 *      applied exactly once.
 *
 *   2. PART ROUTING. There was no part classifier. `predict_image` compared the
 *      peak softmax of two disease heads trained on different label spaces and
 *      sent 12 of 20 fruit photographs to the leaf head. The replacement is a
 *      real binary router whose abstention threshold is pre-registered in
 *      `model.yaml`. The guard asserts the threshold is a fixed declared value
 *      (not fitted here) and, when the production bundle and dataset are
 *      present, that the router clears a measured accuracy floor.
 *
 * TensorFlow import dominates the runtime (~10-90s) so everything runs in ONE
 * subprocess. Skipped, loudly, when the Python package is absent.
 */
const PYTHON = process.platform === "win32" ? "python" : "python3";
const hasPackage = existsSync(path.join(ML_DIR, "citrusguard", "inference", "predictor.py"));
const describePython = hasPackage ? describe : describe.skip;

if (!hasPackage) {
  console.warn("[routing] skipped: no Python package at ml/citrusguard");
}

interface RoutingReport {
  routing_enabled: boolean;
  routing_classes: string[];
  routing_min_confidence: number;
  head_epochs: number;
  finetune_epochs: number;
  part_key_mapping: Record<string, string | null>;
  softmax_head_unchanged: boolean;
  softmax_head_sums_to_one: boolean;
  logits_softmaxed_once: boolean;
  logits_sums_to_one: boolean;
  router_available: boolean;
  router_classes: string[] | null;
  router_probs_normalised: boolean | null;
  router_val_accuracy: number | null;
  router_test_accuracy: number | null;
  router_test_uncertain: number | null;
  router_evaluated_on: number | null;
}

describePython("ML routing and softmax invariants", () => {
  let report: RoutingReport;

  beforeAll(async () => {
    const { stdout } = await run(
      PYTHON,
      [
        "-c",
        `
import json
from pathlib import Path

import numpy as np
import yaml
from tensorflow import keras

import citrusguard
from citrusguard.inference.predictor import (
    ROUTER_PART_KEY,
    _head_ends_in,
    _predict_probs,
    ModelBundle,
    part_key_to_input_type,
)

root = Path(citrusguard.__file__).resolve().parents[2]
cfg = yaml.safe_load((root / "ml" / "citrusguard" / "config" / "model.yaml").read_text("utf-8"))
routing = cfg.get("routing") or {}

# ---- 1. softmax exactly once ------------------------------------------------ #
x = np.random.default_rng(1337).normal(size=(1, 4)).astype("float32")

softmax_in = keras.Input(shape=(4,))
softmax_out = keras.layers.Dense(2, activation="softmax")(softmax_in)
softmax_model = keras.Model(softmax_in, softmax_out)
raw = np.asarray(softmax_model.predict(x, verbose=0))
got = np.asarray(_predict_probs(softmax_model, x))
softmax_head_unchanged = bool(np.allclose(raw, got, atol=1e-6))

linear_in = keras.Input(shape=(4,))
linear_out = keras.layers.Dense(2)(linear_in)
linear_model = keras.Model(linear_in, linear_out)
raw_linear = np.asarray(linear_model.predict(x, verbose=0))
got_linear = np.asarray(_predict_probs(linear_model, x))
shifted = raw_linear - raw_linear.max(axis=-1, keepdims=True)
once = np.exp(shifted) / np.exp(shifted).sum(axis=-1, keepdims=True)
logits_softmaxed_once = bool(np.allclose(got_linear, once, atol=1e-6))

# ---- 2. trained router in the production bundle (optional) ------------------ #
bundle_dir = root / "models" / "production"
manifest_path = bundle_dir / "config.json"
dataset_root = root / "data" / "citrus" / "processed"

router_available = False
router_classes = None
router_probs_normalised = None
router_val_accuracy = None
router_test_accuracy = None
router_test_uncertain = None
router_evaluated_on = None

if manifest_path.is_file():
    bundle = ModelBundle.load(str(bundle_dir))
    router_available = bool(bundle.has_router)
    if router_available:
        router_classes = list(bundle.routing_classes)
        if dataset_root.is_dir():
            from citrusguard.config.loader import model_config
            from citrusguard.dataset.splitter import load_split
            from citrusguard.training.train import build_part_arrays, normalize_for_model

            live = model_config()
            split = load_split(dataset_root)
            for split_name in ("validation", "test"):
                xs, ys, _ = build_part_arrays(
                    dataset_root, list(split.parts), split_name, live,
                    class_order=router_classes,
                )
                probs = np.asarray(
                    bundle.models[ROUTER_PART_KEY].predict(
                        normalize_for_model(xs, live["model"]["preprocessing_method"]),
                        verbose=0,
                    )
                )
                ok = bool(np.allclose(probs.sum(axis=1), 1.0, atol=1e-5))
                acc = float((probs.argmax(axis=1) == ys).mean())
                if split_name == "validation":
                    router_probs_normalised = ok
                    router_val_accuracy = acc
                else:
                    router_probs_normalised = bool(router_probs_normalised and ok)
                    router_test_accuracy = acc
                    router_evaluated_on = int(ys.size)
                    router_test_uncertain = int(
                        (probs.max(axis=1) < bundle.min_routing_confidence).sum()
                    )

print(json.dumps({
    "routing_enabled": bool(routing.get("enabled")),
    "routing_classes": [str(c) for c in routing.get("classes", [])],
    "routing_min_confidence": float(routing.get("min_confidence")),
    "head_epochs": int(routing.get("head_epochs")),
    "finetune_epochs": int(routing.get("finetune_epochs")),
    "part_key_mapping": {
        "Fruits": part_key_to_input_type("part_fruit"),
        "Leaves": part_key_to_input_type("part_leaf"),
        "Router": part_key_to_input_type("part_router"),
    },
    "softmax_head_unchanged": softmax_head_unchanged,
    "softmax_head_sums_to_one": bool(abs(float(got.sum()) - 1.0) < 1e-5),
    "logits_softmaxed_once": logits_softmaxed_once,
    "logits_sums_to_one": bool(abs(float(got_linear.sum()) - 1.0) < 1e-5),
    "router_available": router_available,
    "router_classes": router_classes,
    "router_probs_normalised": router_probs_normalised,
    "router_val_accuracy": router_val_accuracy,
    "router_test_accuracy": router_test_accuracy,
    "router_test_uncertain": router_test_uncertain,
    "router_evaluated_on": router_evaluated_on,
}))
`,
      ],
      {
        cwd: ML_DIR,
        env: { ...process.env, PYTHONPATH: ".", TF_CPP_MIN_LOG_LEVEL: "3" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 600_000,
      },
    );
    report = JSON.parse(stdout.trim().split("\n").pop() as string) as RoutingReport;
  }, 600_000);

  it("declares a pre-registered stage-1 router", () => {
    // The threshold must be a fixed, declared value. If it were computed from
    // the test split here it would be fitted, and the reported coverage would
    // be circular.
    expect(report.routing_enabled).toBe(true);
    expect(report.routing_classes).toEqual(["leaf", "fruit"]);
    expect(report.routing_min_confidence).toBeGreaterThanOrEqual(0.5);
    expect(report.routing_min_confidence).toBeLessThan(1);
    expect(report.head_epochs).toBeGreaterThan(0);
    expect(report.finetune_epochs).toBeGreaterThan(0);
  });

  it("maps each dataset part folder to an input type, and the router to none", () => {
    expect(report.part_key_mapping.Fruits).toBe("fruit");
    expect(report.part_key_mapping.Leaves).toBe("leaf");
    // The router is an identification model, not a disease head: it must not
    // resolve to an input type, or it could be selected as a disease head.
    expect(report.part_key_mapping.Router).toBeNull();
  });

  it("does not apply softmax to a head that already ends in softmax", () => {
    // This is the double-softmax regression. With the bug, `_predict_probs`
    // would return softmax(softmax(logits)), which differs from the model output.
    expect(report.softmax_head_unchanged).toBe(true);
    expect(report.softmax_head_sums_to_one).toBe(true);
  });

  it("applies softmax exactly once to a logits head", () => {
    expect(report.logits_softmaxed_once).toBe(true);
    expect(report.logits_sums_to_one).toBe(true);
  });

  it("ships a trained router in the production bundle", () => {
    // `models/` is git-ignored, so this can only run where a bundle has been
    // deployed. It must not silently pass when a bundle IS present.
    const bundleExists = existsSync(path.join(ROOT, "models", "production", "config.json"));
    if (!bundleExists) {
      console.warn("[routing] no production bundle present; router deployment unchecked");
      return;
    }
    expect(report.router_available).toBe(true);
    expect(report.router_classes).toEqual(["leaf", "fruit"]);
  });

  it("routes the held-out test split well above the legacy heuristic", () => {
    if (report.router_test_accuracy === null) {
      console.warn("[routing] dataset/bundle absent; router accuracy unchecked");
      return;
    }
    expect(report.router_probs_normalised).toBe(true);
    // Measured floor. The heuristic it replaces managed ~0.75 overall on this
    // split (0.94 leaf / 0.40 fruit); a trained router that falls to this floor
    // has stopped being an improvement.
    expect(report.router_test_accuracy).toBeGreaterThan(0.9);
    expect(report.router_evaluated_on).toBeGreaterThan(50);
  });
});
