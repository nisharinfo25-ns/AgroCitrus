"""Measure the deployed SERVING path against the held-out test split.

`training/evaluate.py` reports accuracy straight off `model.predict()` +
`argmax`. This walks the same held-out images through `predict_image` - the exact
entry point the inference worker calls - so any train/serve skew shows up as a
gap between the two numbers instead of hiding.

Since the stage-1 router was added it also measures, for every held-out image:

  * which part the router decided (and how confident it was),
  * whether that part was right,
  * whether the pipeline abstained (`routing_state="uncertain"`), and
  * a strict END-TO-END verdict: right part AND right disease class.

The abstention rate is reported as COVERAGE, and the accuracy of the covered set
is reported separately from the accuracy over everything. That is the honest way
to present a model that is allowed to decline: a refusal is not a correct answer,
and it is not a wrong one either.

Read-only. Point it at whichever bundle you want to judge:

    PYTHONPATH=ml python scripts/verify-serving-accuracy.py \
        --bundle models/production --report reports/training-report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, "ml")

from citrusguard.inference.image_quality import assess_image
from citrusguard.inference.predictor import (
    ModelBundle,
    normalise_class,
    predict_image,
)

DEFAULT_MANIFEST = Path("data/citrus/processed/split_manifest.json")
DEFAULT_BUNDLE = Path("models/production")
DEFAULT_REPORT = Path("reports/training-report.json")

PART_TO_INPUT_TYPE = {"Fruits": "fruit", "Leaves": "leaf"}


def _pct(value: float | None) -> str:
    return "n/a" if value is None else "%.4f" % value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=DEFAULT_BUNDLE)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--split", default="test", choices=["validation", "test"])
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    recorded = json.loads(args.report.read_text(encoding="utf-8")) if args.report.is_file() else {}
    bundle = ModelBundle.load(str(args.bundle))
    bundle_manifest = json.loads((args.bundle / "config.json").read_text(encoding="utf-8"))

    routing_meta = bundle_manifest.get("routing") or {}
    print("deployed bundle : %s %s (%s)"
          % (bundle_manifest.get("model_name"),
             bundle_manifest.get("model_version"),
             str(bundle_manifest.get("model_checksum", ""))[:16] + "..."))
    print("min_confidence  : %s" % bundle.min_confidence)
    print("stage 1         : %s"
          % ("trained router (%s)" % ", ".join(bundle.routing_classes)
             if bundle.has_router else "NO ROUTER - legacy peak-softmax heuristic (a known limitation)"))
    if bundle.has_router:
        print("routing classes : %s" % ", ".join(bundle.routing_classes))
        print("min routing conf: %s (source: %s)"
              % (bundle.min_routing_confidence,
                 "bundle manifest" if routing_meta.get("min_confidence") is not None else "model.yaml"))
        print("router recorded : val_acc=%s test_acc=%s test_coverage=%s"
              % (routing_meta.get("validation_accuracy"),
                 routing_meta.get("test_accuracy"),
                 routing_meta.get("test_coverage")))
    print()
    print("recorded by the TRAINING path (%s):" % args.report.name)
    for part, metrics in (recorded.get("per_part") or {}).items():
        print("  %-8s accuracy=%.4f  n=%s" % (part, metrics["accuracy"], metrics.get("test_images")))
    if recorded.get("mean_test_accuracy") is not None:
        print("  mean     accuracy=%.4f  n=%s"
              % (recorded["mean_test_accuracy"], recorded["total_test_images"]))
    routing_recorded = (recorded.get("routing") or {}).get("splits", {}).get(args.split)
    if routing_recorded:
        print("  router   accuracy=%.4f  coverage=%.4f  uncertain=%d  n=%d"
              % (routing_recorded["accuracy"], routing_recorded["coverage"],
                 routing_recorded["uncertain"], routing_recorded["images"]))
    print()

    grand = Counter()
    global_confidences: list[float] = []
    routing_confidences: list[float] = []
    routing_states: Counter = Counter()
    e2e_correct = 0
    e2e_covered_correct = 0
    e2e_covered = 0

    for part in manifest["parts"]:
        expected_input_type = PART_TO_INPUT_TYPE.get(part)
        rows = [r for r in manifest["assignments"]
                if r["part"] == part and r["split"] == args.split]
        tally = Counter()
        confusion = Counter()
        confidences = []
        part_confidences = []
        correct_input_type = 0
        routed_away = []
        wrong = []
        abstained = []
        state_counts = Counter()

        for row in rows:
            source = Path("data/citrus/raw") / row["source"]
            if not source.is_file():
                tally["missing_file"] += 1
                continue

            quality = assess_image(str(source))
            if not quality.passed:
                tally["gate_rejected"] += 1
                continue

            result = predict_image(
                str(source), bundle, quality_report=quality, enable_gradcam=False
            )
            tally["evaluated"] += 1
            state_counts[result.routing_state] += 1
            routing_states[result.routing_state] += 1
            if result.input_type_confidence is not None:
                part_confidences.append(result.input_type_confidence)
                routing_confidences.append(result.input_type_confidence)

            # A refusal is counted as neither correct nor wrong, but it does
            # reduce coverage, so it can never inflate the accuracy.
            if result.routing_state == "uncertain":
                abstained.append(row["source"])
                continue

            confidences.append(result.confidence)
            global_confidences.append(result.confidence)

            truth = row["class"]
            guessed = result.predicted_class
            confusion[(normalise_class(truth), normalise_class(guessed))] += 1
            disease_ok = normalise_class(truth) == normalise_class(guessed)
            if disease_ok:
                tally["correct"] += 1
            else:
                wrong.append((row["source"], truth, guessed, result.confidence))

            part_ok = result.input_type == expected_input_type
            if part_ok:
                correct_input_type += 1
            elif len(routed_away) < 5:
                routed_away.append((row["source"], result.input_type))

            # End-to-end: the pipeline is only useful if BOTH stages are right.
            if disease_ok and part_ok:
                e2e_correct += 1
                e2e_covered_correct += 1
            e2e_covered += 1

        averaged = tally["evaluated"] - tally["gate_rejected"] - len(abstained)
        print("=== %s (%s split) ===" % (part, args.split))
        print("  images evaluated          : %d" % tally["evaluated"])
        print("  quality gate rejected     : %d" % tally["gate_rejected"])
        print("  stage-1 abstentions       : %d" % len(abstained))
        print("  routing states            : %s"
              % ", ".join("%s=%d" % kv for kv in sorted(state_counts.items())))
        if not averaged:
            print()
            continue
        print("  disease accuracy (served) : %.4f  (%d/%d)"
              % (tally["correct"] / averaged, tally["correct"], averaged))
        print("  part routing accuracy     : %.4f  (%d/%d correct part)"
              % (correct_input_type / averaged, correct_input_type, averaged))
        print("  end-to-end accuracy       : %.4f  (%d/%d right part AND class)"
              % (e2e_correct / averaged, e2e_correct, averaged))
        print("  mean top-1 confidence     : %.4f" % (sum(confidences) / len(confidences)))
        print("  min  top-1 confidence     : %.4f" % min(confidences))
        print("  max  top-1 confidence     : %.4f" % max(confidences))
        print("  below %-7s predictions  : %d of %d"
              % (bundle.min_confidence,
                 sum(1 for c in confidences if c < bundle.min_confidence),
                 averaged))
        if part_confidences:
            print("  mean routing confidence   : %.4f" % (sum(part_confidences) / len(part_confidences)))
            print("  min  routing confidence   : %.4f" % min(part_confidences))

        print("  per-class recall:")
        for cls in manifest["classes"][part]:
            key = normalise_class(cls)
            tp = sum(n for (t, p), n in confusion.items() if t == key and p == key)
            support = sum(n for (t, _p), n in confusion.items() if t == key)
            if support:
                print("    %-28s %d/%d = %.3f" % (cls, tp, support, tp / support))

        if routed_away:
            print("  routed to the wrong part (first 5 of %d):" % (averaged - correct_input_type))
            for source, got in routed_away:
                print("    %-52s -> %s" % (source, got))
        if abstained:
            print("  stage-1 abstentions (first 5 of %d):" % len(abstained))
            for source in abstained[:5]:
                print("    %-52s -> uncertain" % source)
        if wrong:
            print("  misclassified (first 5 of %d):" % len(wrong))
            for source, truth, guessed, conf in wrong[:5]:
                print("    %-52s truth=%-14s got=%-14s conf=%.4f"
                      % (source, truth, guessed, conf))
        print()
        grand.update(tally)
        grand["abstained"] += len(abstained)
        grand["evaluated_all"] += tally["evaluated"]

    print("routing states over %d evaluated held-out images: %s"
          % (grand["evaluated_all"],
             ", ".join("%s=%d" % kv for kv in sorted(routing_states.items()))))
    if routing_confidences:
        print("  mean routing confidence  : %.4f" % (sum(routing_confidences) / len(routing_confidences)))
    if global_confidences:
        print("  mean disease confidence  : %.4f" % (sum(global_confidences) / len(global_confidences)))

    served = grand["evaluated"] - grand["abstained"] - grand["gate_rejected"]
    if grand["evaluated_all"]:
        print()
        print("OVERALL (serving path)")
        print("  images evaluated         : %d" % grand["evaluated_all"])
        print("  coverage (part decided)  : %.4f  (%d/%d)"
              % (served / grand["evaluated_all"], served, grand["evaluated_all"]))
        if served:
            print("  disease accuracy | served : %.4f  (%d/%d)"
                  % (grand["correct"] / served, grand["correct"], served))
            print("  end-to-end | served      : %.4f  (%d/%d)"
                  % (e2e_covered_correct / served, e2e_covered_correct, served))
        print("  end-to-end | all images  : %.4f  (%d/%d, abstentions counted as misses)"
              % (e2e_correct / grand["evaluated_all"], e2e_correct, grand["evaluated_all"]))
        if recorded.get("mean_test_accuracy") is not None:
            print("  (training path recorded %.4f over %s)"
                  % (recorded["mean_test_accuracy"], recorded.get("total_test_images")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
