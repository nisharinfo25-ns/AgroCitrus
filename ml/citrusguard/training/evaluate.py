"""Evaluation and the training report.

Produces a real classification report, confusion matrix, per-part metrics and
the training curves. Every value written here is computed from the trained
model against the held-out test split. Nothing is estimated or filled in.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..common.errors import ValidationError
from ..common.paths import dataset_processed_dir, ensure_dir, get_logger, reports_root
from ..config.loader import model_config
from ..inference.predictor import display_name
from .train import ROUTER_PART_KEY, TrainedModel, build_arrays, build_part_arrays, normalize_for_model

log = get_logger("training.evaluate")


def _metrics(y_true: np.ndarray, y_pred: np.ndarray, classes: list[str]) -> dict[str, Any]:
    from sklearn.metrics import (
        accuracy_score,
        classification_report,
        confusion_matrix,
        f1_score,
        precision_score,
        recall_score,
    )

    report = classification_report(
        y_true, y_pred, labels=list(range(len(classes))), output_dict=True, zero_division=0
    )
    # `output_dict=True` stringifies the label keys ("0", "1", ...) alongside
    # the "macro avg" / "weighted avg" summaries. Filtering on the *string* form
    # is what makes this work: the previous integer check never matched, so
    # `per_class` came out empty and every class-level metric was silently lost.
    per_class: dict[str, Any] = {}
    for key, values in report.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            continue  # "accuracy", "macro avg", "weighted avg"
        if not 0 <= index < len(classes):
            continue
        per_class[display_name(classes[index])] = {
            "precision": float(values["precision"]),
            "recall": float(values["recall"]),
            "f1_score": float(values["f1-score"]),
            "support": int(values["support"]),
        }

    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "macro_precision": float(precision_score(y_true, y_pred, average="macro", zero_division=0)),
        "macro_recall": float(recall_score(y_true, y_pred, average="macro", zero_division=0)),
        "macro_f1": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        "weighted_f1": float(f1_score(y_true, y_pred, average="weighted", zero_division=0)),
        "per_class": per_class,
        "confusion_matrix": confusion_matrix(
            y_true, y_pred, labels=list(range(len(classes)))
        ).tolist(),
        "labels": [display_name(c) for c in classes],
    }


# ---------------------------------------------------------------------------
# Stage-1 router evaluation
# ---------------------------------------------------------------------------
def _threshold_sweep(
    confidence: np.ndarray, correct: np.ndarray, thresholds: np.ndarray
) -> list[dict[str, Any]]:
    """Coverage and selective accuracy of the router at each threshold.

    A router that is allowed to abstain is only useful if the images it
    abstains on are the ones it would have got wrong, so both sides of the
    decision are reported: how much is accepted, and how accurate the accepted
    set is.
    """
    total = int(confidence.size)
    rows: list[dict[str, Any]] = []
    for raw in thresholds:
        threshold = float(raw)
        accepted = confidence >= threshold
        n = int(accepted.sum())
        rows.append(
            {
                "threshold": round(threshold, 2),
                "accepted": n,
                "coverage": round(n / total, 4) if total else 0.0,
                "selective_accuracy": round(float(correct[accepted].mean()), 4) if n else None,
                "accuracy_if_rejected": (
                    round(float(correct[~accepted].mean()), 4) if total - n else None
                ),
            }
        )
    return rows


def _routing_split_report(
    y_true: np.ndarray, probabilities: np.ndarray, classes: list[str], threshold: float
) -> dict[str, Any]:
    y_pred = np.argmax(probabilities, axis=1)
    confidence = probabilities.max(axis=1)
    correct = y_pred == y_true
    metrics = _metrics(y_true, y_pred, classes)

    accepted = confidence >= threshold
    n_accepted = int(accepted.sum())
    n_rejected = int((~accepted).sum())
    per_actual: dict[str, Any] = {}
    for index, name in enumerate(classes):
        actual = y_true == index
        n = int(actual.sum())
        per_actual[display_name(name)] = {
            "images": n,
            "routed_correctly": int((actual & correct).sum()),
            "routing_accuracy": round(float(correct[actual].mean()), 4) if n else None,
            "uncertain": int((actual & ~accepted).sum()),
        }

    return {
        "images": int(y_true.size),
        "accuracy": metrics["accuracy"],
        "macro_f1": metrics["macro_f1"],
        "per_class": metrics["per_class"],
        "confusion_matrix": metrics["confusion_matrix"],
        "labels": metrics["labels"],
        "per_actual_part": per_actual,
        "mean_confidence": round(float(confidence.mean()), 4),
        "min_confidence": round(float(confidence.min()), 4),
        "threshold": threshold,
        "accepted": n_accepted,
        "coverage": round(n_accepted / y_true.size, 4) if y_true.size else 0.0,
        "accuracy_on_accepted": round(float(correct[accepted].mean()), 4) if n_accepted else None,
        "uncertain": n_rejected,
        "accuracy_on_uncertain": round(float(correct[~accepted].mean()), 4) if n_rejected else None,
        "errors": int((~correct).sum()),
    }


def evaluate_router(
    router: TrainedModel,
    *,
    processed_root: Path,
    config: dict[str, Any],
    split_parts: Sequence[str],
) -> dict[str, Any]:
    """Evaluate the Leaf-vs-Fruit router on the held-out validation and test splits.

    The abstention threshold is *pre-registered* in ``model.yaml`` rather than
    fitted here, so the test split cannot be tuned against. The full sweep from
    0.50 to 0.99 is written alongside it so the chosen value can be audited and,
    if it is wrong, re-chosen with evidence.
    """
    from .train import normalize_for_model as _normalize

    routing_cfg = config.get("routing") or {}
    classes = [str(c) for c in routing_cfg.get("classes", ["leaf", "fruit"])]
    threshold = float(routing_cfg.get("min_confidence", 0.95))
    method = config["model"].get("preprocessing_method", "mobilenet_v2_imagenet")
    sweep_thresholds = np.round(np.arange(0.50, 1.00, 0.01), 2)

    splits: dict[str, Any] = {}
    sweep: dict[str, Any] = {}
    for split_name in ("validation", "test"):
        x, y, skipped = build_part_arrays(
            processed_root, list(split_parts), split_name, config, class_order=classes
        )
        probabilities = np.asarray(
            router.model.predict(_normalize(x, method), verbose=0), dtype=np.float64
        )
        if probabilities.ndim == 1:
            probabilities = np.expand_dims(probabilities, axis=1)
        if probabilities.shape[-1] != len(classes):
            raise ValidationError(
                f"The router outputs {probabilities.shape[-1]} values but "
                f"{len(classes)} routing classes are configured."
            )
        entry = _routing_split_report(y, probabilities, classes, threshold)
        entry["skipped_unreadable"] = int(skipped)
        splits[split_name] = entry
        sweep[split_name] = _threshold_sweep(
            probabilities.max(axis=1), np.argmax(probabilities, axis=1) == y, sweep_thresholds
        )

    return {
        "architecture": config["model"]["architecture"],
        "input_size": config["model"]["input_size"],
        "preprocessing_method": config["model"].get("preprocessing_method"),
        "classes": classes,
        "threshold": threshold,
        # Stated explicitly so nobody reads the number as fitted on the test set.
        "threshold_selection": (
            "pre-registered in ml/citrusguard/config/model.yaml (routing.min_confidence); "
            "not fitted against the validation or test split"
        ),
        "splits": splits,
        "sweep": sweep,
        "training_seconds": float(router.training_seconds),
        "model_parameters": int(router.model_params),
        "counts": dict(router.counts),
    }


def _plot_confusion_matrix(matrix: list[list[int]], labels: list[str], destination: Path) -> str | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ModuleNotFoundError:  # pragma: no cover
        log.warning("matplotlib is unavailable; skipping the confusion matrix image.")
        return None

    array = np.asarray(matrix, dtype=float)
    row_sums = array.sum(axis=1, keepdims=True)
    normalised = np.divide(array, row_sums, out=np.zeros_like(array), where=row_sums > 0)

    size = max(6.0, min(16.0, 1.1 * len(labels) + 3.5))
    figure, axes = plt.subplots(figsize=(size, size * 0.85))
    image = axes.imshow(normalised, cmap="YlGnBu", vmin=0.0, vmax=1.0)
    figure.colorbar(image, ax=axes, fraction=0.046, pad=0.04, label="Proportion of actual class")

    axes.set_xticks(range(len(labels)), labels, rotation=45, ha="right", fontsize=9)
    axes.set_yticks(range(len(labels)), labels, fontsize=9)
    axes.set_xlabel("Predicted class")
    axes.set_ylabel("Actual class")
    axes.set_title("Confusion matrix (row-normalised, test split)")

    threshold = normalised.max() / 2.0 if normalised.size else 0.5
    for i in range(array.shape[0]):
        for j in range(array.shape[1]):
            axes.text(
                j,
                i,
                f"{int(array[i, j])}\n{normalised[i, j]:.0%}",
                ha="center",
                va="center",
                fontsize=8,
                color="white" if normalised[i, j] > threshold else "#1f2937",
            )
    figure.tight_layout()
    destination.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(destination, dpi=140)
    plt.close(figure)
    return str(destination)


def _plot_curves(history: dict[str, list[float]], destination: Path) -> str | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ModuleNotFoundError:  # pragma: no cover
        return None

    figure, (loss_axes, acc_axes) = plt.subplots(1, 2, figsize=(12, 4.5))
    plotted = False
    for phase in ("phase1", "phase2"):
        epochs = range(1, len(history.get(f"{phase}_loss", [])) + 1)
        if not epochs:
            continue
        plotted = True
        loss_axes.plot(epochs, history[f"{phase}_loss"], label=f"{phase} train")
        loss_axes.plot(epochs, history.get(f"{phase}_val_loss", []), linestyle="--", label=f"{phase} val")
        acc_axes.plot(epochs, history.get(f"{phase}_accuracy", []), label=f"{phase} train")
        acc_axes.plot(epochs, history.get(f"{phase}_val_accuracy", []), linestyle="--", label=f"{phase} val")

    if not plotted:
        plt.close(figure)
        return None

    loss_axes.set_title("Loss")
    loss_axes.set_xlabel("Epoch")
    loss_axes.set_ylabel("Sparse categorical crossentropy")
    loss_axes.legend(fontsize=8)
    acc_axes.set_title("Accuracy")
    acc_axes.set_xlabel("Epoch")
    acc_axes.set_ylabel("Accuracy")
    acc_axes.legend(fontsize=8)
    figure.suptitle("Training curves (phase 1 = frozen backbone, phase 2 = fine-tuned)")
    figure.tight_layout()
    destination.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(destination, dpi=140)
    plt.close(figure)
    return str(destination)


def evaluate(
    trained: dict[str, TrainedModel],
    *,
    output_dir: Path | None = None,
    processed_root: Path | None = None,
) -> dict[str, Any]:
    """Evaluate every trained part on the held-out test split."""
    config = model_config()
    processed_root = Path(processed_root or dataset_processed_dir())
    output_dir = ensure_dir(Path(output_dir or reports_root()))

    per_part: dict[str, Any] = {}
    artefacts: dict[str, Any] = {}

    preprocessing_method = config["model"].get("preprocessing_method", "mobilenet_v2_imagenet")

    for part, entry in trained.items():
        # The router predicts a different label space (Leaf vs Fruit), so it is
        # measured by `evaluate_router` on the same held-out splits rather than
        # being scored against the disease test split.
        if entry.part_key == ROUTER_PART_KEY:
            continue
        log.info("Evaluating part %r on the test split", part)
        x_test, y_test, skipped = build_arrays(processed_root, part, "test", entry.classes, config)
        # `build_arrays` returns uint8 (so the training path can augment in the
        # right range). The model expects the scaled range, exactly as the
        # training dataset pipeline produced it.
        x_test_scaled = normalize_for_model(x_test, preprocessing_method)
        # All heads are softmax over len(classes) outputs, so argmax is correct
        # and the class index maps straight back onto ``entry.classes``.
        probabilities = np.asarray(entry.model.predict(x_test_scaled, verbose=0))
        if probabilities.ndim == 1:
            probabilities = np.expand_dims(probabilities, axis=0)
        if probabilities.shape[-1] != len(entry.classes):
            raise ValidationError(
                f"Model head '{entry.part_key}' outputs {probabilities.shape[-1]} values "
                f"but {len(entry.classes)} classes were discovered in the dataset."
            )

        y_pred = np.argmax(probabilities, axis=1)
        y_true = y_test
        if y_pred.shape != y_true.shape:
            y_pred = y_pred[: y_true.shape[0]]

        result = _metrics(y_true, y_pred, entry.classes)
        result["test_images"] = int(len(x_test))
        result["skipped_unreadable"] = int(skipped)
        result["training_seconds"] = entry.training_seconds
        result["model_parameters"] = entry.model_params
        result["best_validation_accuracy"] = _best(history=entry.history, key="val_accuracy")
        result["best_validation_loss"] = _best(history=entry.history, key="val_loss", mode="min")
        per_part[part] = result

        matrix_path = output_dir / f"confusion-matrix-{entry.part_key}.png"
        matrix_file = _plot_confusion_matrix(result["confusion_matrix"], result["labels"], matrix_path)
        curves_path = output_dir / f"training-curves-{entry.part_key}.png"
        curves_file = _plot_curves(entry.history, curves_path)
        artefacts[entry.part_key] = {
            "confusion_matrix_png": matrix_file,
            "training_curves_png": curves_file,
        }

    # ---- stage-1 router ------------------------------------------------- #
    routing_report: dict[str, Any] | None = None
    router_model = next(
        (e for e in trained.values() if e.part_key == ROUTER_PART_KEY), None
    )
    if router_model is not None:
        split_parts = [
            p for p in trained if str(p).strip().lower() not in {"part", "parts", "router", "routing"}
        ]
        log.info("Evaluating the Leaf-vs-Fruit router on the held-out splits")
        routing_report = evaluate_router(
            router_model,
            processed_root=processed_root,
            config=config,
            split_parts=split_parts,
        )
        for split_name, entry in routing_report["splits"].items():
            log.info(
                "Router %s: accuracy=%.4f coverage=%.4f uncertain=%d",
                split_name,
                entry["accuracy"],
                entry["coverage"],
                entry["uncertain"],
            )

        test_split = routing_report["splits"]["test"]
        routing_report["confusion_matrix_png"] = _plot_confusion_matrix(
            test_split["confusion_matrix"],
            test_split["labels"],
            output_dir / f"confusion-matrix-{ROUTER_PART_KEY}.png",
        )

    # The part-level accuracy quoted in the UI is the mean across parts.
    accuracies = [v["accuracy"] for v in per_part.values() if v.get("accuracy") is not None]
    report: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "architecture": config["model"]["architecture"],
        "input_size": config["model"]["input_size"],
        "per_part": per_part,
        "routing": routing_report,
        "artefacts": artefacts,
        "mean_test_accuracy": float(np.mean(accuracies)) if accuracies else None,
        "total_test_images": int(sum(v["test_images"] for v in per_part.values())),
        "total_training_seconds": float(sum(v["training_seconds"] for v in per_part.values())),
    }
    if routing_report is not None:
        report["total_training_seconds"] += float(routing_report.get("training_seconds") or 0.0)
    report["dataset_size"] = _dataset_size(processed_root)

    path = output_dir / "training-report.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    log.info("Training report written -> %s", path)
    return report


def _best(*, history: dict[str, list[float]], key: str, mode: str = "max") -> float | None:
    candidates = [
        value
        for phase in ("phase1", "phase2")
        for value in history.get(f"{phase}_{key}", [])
        if value is not None
    ]
    if not candidates:
        return None
    return float(max(candidates) if mode == "max" else min(candidates))


def _dataset_size(processed_root: Path) -> int:
    return int(sum(1 for p in processed_root.rglob("*") if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png"}))
