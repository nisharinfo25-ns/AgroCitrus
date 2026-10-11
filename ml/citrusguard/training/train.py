"""Model training, evaluation and export.

Training is a two-phase transfer-learning run on a frozen ImageNet
MobileNetV2 backbone:

    phase 1  freeze the backbone, train the classification head
    phase 2  unfreeze the top of the backbone and fine-tune at a low LR

Only measured metrics are ever written. If a stage did not run, the key is
``None`` and the web app renders "Not available" instead of a percentage.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..common.errors import ValidationError
from ..common.paths import dataset_processed_dir, ensure_dir, get_logger, models_root
from ..config.loader import DatasetConfig, dataset_config, model_config
from ..dataset.preprocessor import (
    build_train_augmenter,
    decode_image,
    resize_rgb,
    scale_for_model,
)
from ..dataset.splitter import SplitResult, load_split
from ..inference.predictor import (
    PART_FRUIT,
    PART_LEAF,
    ROUTER_PART_KEY,
    part_key_to_input_type,
)

log = get_logger("training")

SPLIT_TO_FLOWER = {"train": "training", "validation": "validation", "test": "test"}

# Re-exported from `inference.predictor` so training, export, evaluation and
# inference all agree on the single artifact key for the stage-1 router.
# It is deliberately named like the two disease heads so `ModelBundle` loads it
# through the same `config.artifacts` loop, but it is NOT a disease head: it is
# excluded from `classes_by_part` and reported in its own `routing` block.


@dataclass
class TrainedModel:
    part: str
    part_key: str
    classes: list[str]
    model: Any
    history: dict[str, list[float]]
    training_seconds: float
    model_params: int
    counts: dict[str, int] = field(default_factory=dict)


def _build_architecture(config: dict[str, Any], num_classes: int) -> Any:
    from tensorflow import keras

    size = tuple(config["model"]["input_size"])
    architecture = config["model"].get("architecture", "mobilenet_v2")

    if architecture == "mobilenet_v2":
        base = keras.applications.MobileNetV2(
            input_shape=(*size, 3),
            include_top=False,
            weights=config["model"].get("weights", "imagenet"),
            pooling="avg",
        )
    elif architecture == "efficientnet_b0":
        base = keras.applications.EfficientNetB0(
            input_shape=(*size, 3),
            include_top=False,
            weights=config["model"].get("weights", "imagenet"),
            pooling="avg",
        )
    else:
        raise ValidationError(
            f"Unsupported architecture '{architecture}'.",
            detail="Supported: mobilenet_v2, efficientnet_b0",
        )

    model = keras.Sequential(
        [
            keras.layers.Input(shape=(*size, 3)),
            base,
            keras.layers.Dropout(0.3),
            keras.layers.Dense(128, activation="relu"),
            keras.layers.Dropout(0.2),
            keras.layers.Dense(num_classes, activation="softmax", name="disease_head"),
        ],
        name=f"citrusguard_{architecture}",
    )
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=config["training"]["head_learning_rate"]),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model


def build_arrays(
    processed_root: Path, part: str, split: str, classes: list[str], config: dict[str, Any]
) -> tuple[np.ndarray, np.ndarray, int]:
    """Return the split arrays plus a count of images skipped as unreadable.

    The returned images are **uint8**, not normalised. Augmentation layers such
    as ``RandomBrightness`` and ``RandomZoom`` are defined against a 0-255
    range; running them on already-normalised ``[-1, 1]`` tensors makes a
    translation's fill value mid-grey instead of black and scales the brightness
    delta incorrectly, which silently degrades training.

    Normalisation is therefore the last step of the pipeline, applied by
    :func:`normalize_for_model` after augmentation - the same order the
    inference path uses, which is what keeps train/serve skew impossible.
    """
    size = tuple(config["model"]["input_size"])
    images: list[np.ndarray] = []
    labels: list[int] = []
    skipped = 0

    for index, class_name in enumerate(classes):
        class_dir = processed_root / part.lower() / split / class_name
        if not class_dir.is_dir():
            log.warning("Missing split folder %s", class_dir)
            continue
        for image_path in sorted(class_dir.iterdir()):
            if not image_path.is_file():
                continue
            try:
                image = resize_rgb(decode_image(image_path), size)
            except Exception as exc:
                log.warning("Skipping unreadable image %s: %s", image_path.name, exc)
                skipped += 1
                continue
            images.append(image)
            labels.append(index)

    if not images:
        raise ValidationError(
            f"Split '{split}' for part '{part}' is empty. Re-run dataset prepare.",
            detail=str(processed_root / part.lower() / split),
        )
    return np.stack(images), np.asarray(labels, dtype=np.int32), skipped


def build_part_arrays(
    processed_root: Path,
    parts: Sequence[str],
    split: str,
    config: dict[str, Any],
    *,
    class_order: Sequence[str],
) -> tuple[np.ndarray, np.ndarray, int]:
    """Images and per-**part** labels for the Leaf-vs-Fruit router.

    The labels come from the dataset's own folder structure (``Leaves/`` vs
    ``Fruits/``) and are resolved to the canonical input types through
    :func:`part_key_to_input_type`, so a folder rename can never silently
    relabel the router. The index of each label is its position in
    ``class_order``, which is the same order the exported config records.

    Train/validation/test membership is inherited unchanged from the shared
    ``split_manifest.json``: an image is routed-train exactly when it is
    disease-train, so the router can never see a held-out test image.
    """
    size = tuple(config["model"]["input_size"])
    images: list[np.ndarray] = []
    labels: list[int] = []
    skipped = 0

    for part in parts:
        input_type = part_key_to_input_type(part_key(part))
        if input_type is None or input_type not in class_order:
            raise ValidationError(
                f"Part folder {part!r} does not map onto the configured router classes.",
                detail=f"router classes: {list(class_order)}",
            )
        label = list(class_order).index(input_type)
        part_dir = Path(processed_root) / part.lower() / split
        if not part_dir.is_dir():
            log.warning("Missing split folder %s", part_dir)
            continue
        for class_dir in sorted(p for p in part_dir.iterdir() if p.is_dir()):
            for image_path in sorted(class_dir.iterdir()):
                if not image_path.is_file():
                    continue
                try:
                    image = resize_rgb(decode_image(image_path), size)
                except Exception as exc:
                    log.warning("Skipping unreadable image %s: %s", image_path.name, exc)
                    skipped += 1
                    continue
                images.append(image)
                labels.append(label)

    if not images:
        raise ValidationError(
            f"Split '{split}' contains no images for the part router.",
            detail=str(processed_root),
        )
    return np.stack(images), np.asarray(labels, dtype=np.int32), skipped


def train_router(
    config: dict[str, Any],
    split: SplitResult,
    *,
    processed_root: Path | None = None,
) -> TrainedModel:
    """Train the explicit Leaf-vs-Fruit stage-1 router.

    Binary MobileNetV2 transfer learning over every image in the split, with
    labels taken from the dataset's part folders. Same two-phase schedule,
    augmentation, class weighting and seed as the disease heads, so the router
    is trained under identical conditions rather than being an ad-hoc extra.
    """
    import tensorflow as tf

    routing_cfg = config.get("routing") or {}
    class_order = [str(c) for c in routing_cfg.get("classes", ["leaf", "fruit"])]
    if len(set(class_order)) != 2:
        raise ValidationError(
            "routing.classes must declare exactly two distinct input types.",
            detail=str(class_order),
        )

    processed_root = Path(processed_root or dataset_processed_dir())
    seed = int(config["model"].get("seed", 1337))
    tf.keras.utils.set_random_seed(seed)
    preprocessing_method = config["model"].get("preprocessing_method", "mobilenet_v2_imagenet")

    parts = list(split.parts)
    log.info("Loading router arrays for %d parts (%s)", len(parts), ", ".join(parts))
    x_train, y_train, _ = build_part_arrays(
        processed_root, parts, "train", config, class_order=class_order
    )
    x_val, y_val, _ = build_part_arrays(
        processed_root, parts, "validation", config, class_order=class_order
    )
    log.info("Router: train=%d val=%d", len(x_train), len(x_val))

    model = _build_architecture(config, num_classes=len(class_order))
    started = time.perf_counter()
    history = _fit_two_phase(
        model,
        x_train=x_train,
        y_train=y_train,
        x_val=x_val,
        y_val=y_val,
        config=config,
        seed=seed,
        preprocessing_method=preprocessing_method,
        label="Part router",
        num_classes=len(class_order),
        head_epochs=int(routing_cfg.get("head_epochs", 8)),
        finetune_epochs=int(routing_cfg.get("finetune_epochs", 15)),
    )

    return TrainedModel(
        part="Parts",
        part_key=ROUTER_PART_KEY,
        classes=list(class_order),
        model=model,
        history=history,
        training_seconds=round(time.perf_counter() - started, 2),
        model_params=int(model.count_params()),
        counts={
            "train": int(len(x_train)),
            "validation": int(len(x_val)),
            "input_size": int(config["model"]["input_size"][0]),
        },
    )


def normalize_for_model(images: np.ndarray, preprocessing_method: str) -> np.ndarray:
    """Scale a uint8 batch to the range the backbone was pre-trained for.

    Delegates to :func:`scale_for_model`, the same function the inference path
    uses. Keeping one implementation is what makes train/serve skew
    impossible; a second copy here would be free to drift out of sync.
    """
    return scale_for_model(images, preprocessing_method)


def class_weights(y: np.ndarray, num_classes: int) -> dict[int, float]:
    """Inverse-frequency class weights.

    The dataset is heavily imbalanced - Leaves holds 205 greening images against
    14 melanose ones. Unweighted, cross-entropy minimises total loss by
    predicting the majority class, so the rare diseases are never learned.
    """
    counts = np.bincount(y, minlength=num_classes).astype(np.float64)
    present = counts > 0
    weights = np.zeros(num_classes, dtype=np.float64)
    if present.any():
        weights[present] = counts.sum() / (float(present.sum()) * counts[present])
    return {index: float(weights[index]) for index in range(num_classes)}


def freeze_batch_norm(model: Any) -> int:
    """Freeze every BatchNormalization layer in the tree, including nested ones.

    Iterating ``model.layers`` only reaches the top level, so on a model that
    embeds the backbone as a single sub-model the BatchNorm layers inside it
    stay trainable. Fine-tuning those on a few hundred images destroys the
    pretrained running statistics and is a common cause of a model collapsing
    onto the majority class.
    """
    from tensorflow import keras

    frozen = 0
    for layer in model.layers:
        if isinstance(layer, keras.layers.BatchNormalization):
            layer.trainable = False
            frozen += 1
        elif isinstance(layer, keras.Model):
            frozen += freeze_batch_norm(layer)
    return frozen


def _dataset_factory(
    x: np.ndarray,
    y: np.ndarray,
    config: dict[str, Any],
    *,
    seed: int,
    preprocessing_method: str,
    training: bool,
) -> Any:
    """Build one tf.data pipeline: augment (train only) then scale, once."""
    import tensorflow as tf

    train_cfg = config["training"]
    normalise = lambda a: normalize_for_model(a, preprocessing_method)  # noqa: E731

    # Order matters: augment on uint8, then normalise. Augmenting after
    # normalisation corrupts the augmentation's reference range.
    dataset = tf.data.Dataset.from_tensor_slices((x, y)).shuffle(
        len(x), seed=seed, reshuffle_each_iteration=training
    )
    # Augmentation is applied to the TRAINING split only. Validation and
    # test data must never see it, otherwise the reported metrics would be
    # measured on transformed images the model will not be served.
    if training:
        augmenter = build_train_augmenter(config)
        if augmenter is not None:
            dataset = dataset.map(
                lambda a, b: (augmenter(a, training=True), b),
                num_parallel_calls=tf.data.AUTOTUNE,
            )
    dataset = dataset.map(lambda a, b: (normalise(a), b), num_parallel_calls=tf.data.AUTOTUNE)
    # Deterministic order for evaluation folds.
    if not training:
        dataset = dataset.shuffle(len(x), seed=seed, reshuffle_each_iteration=False)
    return dataset.batch(int(train_cfg["batch_size"])).prefetch(tf.data.AUTOTUNE)


def _build_callbacks(config: dict[str, Any]) -> list[Any]:
    """Fresh callbacks per phase.

    Keras callbacks are stateful (best value, wait counter, LR schedule).
    Reusing the same instances across both phases would carry phase 1's
    "best" into phase 2, so early stopping could fire before phase 2 had a
    chance to improve anything.
    """
    from tensorflow import keras

    train_cfg = config["training"]
    return [
        keras.callbacks.EarlyStopping(
            monitor=train_cfg["early_stopping"]["monitor"],
            patience=int(train_cfg["early_stopping"]["patience"]),
            restore_best_weights=bool(train_cfg["early_stopping"]["restore_best_weights"]),
            verbose=1,
        ),
        keras.callbacks.ReduceLROnPlateau(
            monitor=train_cfg["reduce_lr_on_plateau"]["monitor"],
            factor=float(train_cfg["reduce_lr_on_plateau"]["factor"]),
            patience=int(train_cfg["reduce_lr_on_plateau"]["patience"]),
            min_lr=float(train_cfg["reduce_lr_on_plateau"]["min_learning_rate"]),
            verbose=1,
        ),
    ]


def freeze_backbone_keep_head(model: Any) -> int:
    """Freeze the backbone WITHOUT freezing the classification head.

    ``model.trainable = False`` is a trap. It sets the *container's* own
    ``_trainable`` flag, and Keras short-circuits on it:

        @property
        def trainable_weights(self):
            if not self.trainable:
                return []

    so switching every head layer back on by hand does not help: the container
    still reports ``trainable=False`` and exposes ZERO trainable weights. That is
    exactly what the first fix attempt did, and it reproduced the original bug -
    ``phase1_val_loss`` stayed byte-identical across all ten epochs (1.602 for
    fruit) while the training loss moved only because of shuffling and
    augmentation.

    Freezing only the backbone *layer* leaves the container trainable, so the
    head's weights stay visible. Measured against the installed Keras on this
    project's architecture: ``len(model.trainable_variables)`` is **0** with the
    ``model.trainable = False`` idiom and **4** with this one (two Dense layers,
    kernel + bias each). The backbone is the only nested ``keras.Model`` in the
    tree, so everything outside it is head. Returns the number of head layers.
    """
    from tensorflow import keras

    trainable = 0
    for layer in model.layers:
        if isinstance(layer, keras.Model):
            layer.trainable = False
        else:
            layer.trainable = True
            trainable += 1
    return trainable


def _fit_two_phase(
    model: Any,
    *,
    x_train: np.ndarray,
    y_train: np.ndarray,
    x_val: np.ndarray,
    y_val: np.ndarray,
    config: dict[str, Any],
    seed: int,
    preprocessing_method: str,
    label: str,
    num_classes: int,
    head_epochs: int | None = None,
    finetune_epochs: int | None = None,
) -> dict[str, list[float]]:
    """Run the documented two-phase schedule and return the training curves."""
    import tensorflow as tf
    from tensorflow import keras

    train_cfg = config["training"]

    train_ds = _dataset_factory(
        x_train, y_train, config, seed=seed, preprocessing_method=preprocessing_method, training=True
    )
    val_ds = _dataset_factory(
        x_val, y_val, config, seed=seed, preprocessing_method=preprocessing_method, training=False
    )
    weights = class_weights(y_train, num_classes)
    log.info(
        "%s class weights: %s",
        label,
        {i: round(w, 3) for i, w in weights.items() if w > 0},
    )

    # ---- phase 1: frozen backbone, TRAINABLE head ---------------------- #
    freeze_backbone_keep_head(model)
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=float(train_cfg["head_learning_rate"])),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    n_head = int(head_epochs if head_epochs is not None else train_cfg["head_epochs"])
    log.info("%s phase 1: training head for %d epochs", label, n_head)
    head_history = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=n_head,
        callbacks=_build_callbacks(config),
        class_weight=weights,
        verbose=2,
    )

    # ---- phase 2: fine-tune -------------------------------------------- #
    model.trainable = True
    frozen = freeze_batch_norm(model)
    log.info("%s phase 2: fine-tuning backbone (%d BatchNorm layers frozen)", label, frozen)
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=float(train_cfg["finetune_learning_rate"])),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    n_ft = int(finetune_epochs if finetune_epochs is not None else train_cfg["epochs"])
    finetune_history = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=n_ft,
        callbacks=_build_callbacks(config),
        class_weight=weights,
        verbose=2,
    )

    return {
        "phase1_loss": list(map(float, head_history.history.get("loss", []))),
        "phase1_val_loss": list(map(float, head_history.history.get("val_loss", []))),
        "phase1_accuracy": list(map(float, head_history.history.get("accuracy", []))),
        "phase1_val_accuracy": list(map(float, head_history.history.get("val_accuracy", []))),
        "phase2_loss": list(map(float, finetune_history.history.get("loss", []))),
        "phase2_val_loss": list(map(float, finetune_history.history.get("val_loss", []))),
        "phase2_accuracy": list(map(float, finetune_history.history.get("accuracy", []))),
        "phase2_val_accuracy": list(map(float, finetune_history.history.get("val_accuracy", []))),
    }


def train_part(
    part: str,
    classes: list[str],
    config: dict[str, Any],
    split: SplitResult,
    *,
    processed_root: Path | None = None,
) -> TrainedModel:
    """Train the classifier for one part (Leaf or Fruit)."""
    import tensorflow as tf
    from tensorflow import keras

    processed_root = Path(processed_root or dataset_processed_dir())
    seed = int(config["model"].get("seed", 1337))
    tf.keras.utils.set_random_seed(seed)

    train_cfg = config["training"]
    size = tuple(config["model"]["input_size"])
    preprocessing_method = config["model"].get("preprocessing_method", "mobilenet_v2_imagenet")

    log.info("Loading split arrays for part %r (%d classes)", part, len(classes))
    x_train, y_train, _ = build_arrays(processed_root, part, "train", classes, config)
    x_val, y_val, _ = build_arrays(processed_root, part, "validation", classes, config)
    log.info("Part %r: train=%d val=%d", part, len(x_train), len(x_val))

    model = _build_architecture(config, num_classes=len(classes))
    started = time.perf_counter()

    history = _fit_two_phase(
        model,
        x_train=x_train,
        y_train=y_train,
        x_val=x_val,
        y_val=y_val,
        config=config,
        seed=seed,
        preprocessing_method=preprocessing_method,
        label=f"Part {part!r}",
        num_classes=len(classes),
    )

    part_key = PART_FRUIT if part.strip().lower().startswith("fruit") else PART_LEAF
    return TrainedModel(
        part=part,
        part_key=part_key,
        classes=list(classes),
        model=model,
        history=history,
        training_seconds=round(time.perf_counter() - started, 2),
        model_params=int(model.count_params()),
        counts={
            "train": int(len(x_train)),
            "validation": int(len(x_val)),
            "input_size": int(size[0]),
        },
    )


def part_key(part: str) -> str:
    """Filename stem for a part's artefact, e.g. ``Leaves`` -> ``part_leaf``.

    Mirrors the mapping :func:`train_part` applies to the returned
    ``TrainedModel``. Both must agree: a mismatch would make the resume path
    look for ``part_leaves.keras`` next to the artefact it just wrote as
    ``part_leaf.keras``, and silently retrain on every run.

    ``Parts`` (the stage-1 router's synthetic part) resolves to
    ``part_router``.
    """
    name = part.strip().lower()
    if name in {"part", "parts", "router", "part router", "part_router"}:
        return ROUTER_PART_KEY
    return PART_FRUIT if name.startswith("fruit") else PART_LEAF


def sidecar_path(output_dir: Path, part: str) -> Path:
    return output_dir / f"{part_key(part)}.json"


def write_sidecar(output_dir: Path, trained: TrainedModel) -> Path:
    """Write the per-part metadata needed to reload an artefact without retraining.

    The Keras file holds weights only. Without this sidecar a resumed run could
    not report that part's classes, timings or training curves, so `evaluate`
    would silently lose a whole part's metrics.
    """
    target = sidecar_path(output_dir, trained.part)
    payload = {
        "part": trained.part,
        "part_key": trained.part_key,
        "classes": list(trained.classes),
        "training_seconds": float(trained.training_seconds),
        "model_params": int(trained.model_params),
        "counts": dict(trained.counts),
        "history": {k: [float(x) for x in v] for k, v in trained.history.items()},
    }
    target.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return target


def load_trained(output_dir: Path, part: str, classes: list[str]) -> TrainedModel | None:
    """Reload a previously trained part, or return None if it is not usable.

    Returns None rather than raising when the artefact or sidecar is missing,
    because that is the normal case on a first run - the caller decides whether
    to train or to fail.
    """
    artifact = output_dir / f"{part_key(part)}.keras"
    meta = sidecar_path(output_dir, part)
    if not artifact.exists() or not meta.exists():
        return None

    try:
        payload = json.loads(meta.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        log.warning("Ignoring unreadable sidecar %s: %s", meta, exc)
        return None

    recorded = list(payload.get("classes") or [])
    # A sidecar from a different class set describes a different model. Retraining
    # is safer than loading weights whose output indices no longer line up.
    if recorded and recorded != list(classes):
        log.warning(
            "Sidecar for %s lists classes %s but the split now has %s; retraining.",
            part,
            recorded,
            list(classes),
        )
        return None

    from tensorflow import keras

    return TrainedModel(
        part=part,
        part_key=part_key(part),
        classes=list(classes),
        model=keras.models.load_model(str(artifact)),
        history={k: list(v) for k, v in (payload.get("history") or {}).items()},
        training_seconds=float(payload.get("training_seconds") or 0.0),
        model_params=int(payload.get("model_params") or 0),
        counts=dict(payload.get("counts") or {}),
    )


def train_all(
    *,
    processed_root: Path | None = None,
    output_dir: Path | None = None,
    only_parts: Sequence[str] | None = None,
    resume: bool = False,
) -> dict[str, TrainedModel]:
    """Train every part discovered in the split. Returns part -> TrainedModel.

    ``only_parts`` restricts training to the named parts (case-insensitive). Any
    other part is taken from disk when ``resume`` is set, and is simply absent
    otherwise - so ``only_parts`` without ``resume`` trains just those parts and
    returns only those parts, which is what a targeted retrain wants.
    """
    config = model_config()
    split = load_split(processed_root)
    if not split.parts:
        raise ValidationError("The prepared split contains no image categories.")

    output_dir = ensure_dir(Path(output_dir or models_root() / "incoming"))
    results: dict[str, TrainedModel] = {}

    wanted = {name.strip().lower() for name in only_parts} if only_parts else None
    routing_cfg = config.get("routing") or {}
    router_enabled = bool(routing_cfg.get("enabled", False))
    router_classes = [str(c) for c in routing_cfg.get("classes", ["leaf", "fruit"])]
    # `Parts` is the router's synthetic part: it is not a folder in the
    # dataset, so it has to be added to the accepted names explicitly or
    # `--parts router` would be rejected as unknown.
    router_aliases = {"parts", "part", "router", "routing"}
    if wanted:
        known = {part.lower() for part in split.parts}
        if router_enabled:
            known |= router_aliases
        unknown = wanted - known
        if unknown:
            raise ValidationError(
                f"Unknown part(s): {', '.join(sorted(unknown))}.",
                detail=f"Known parts: {', '.join(sorted(split.parts))}",
            )

    for part in split.parts:
        classes = split.classes.get(part, [])
        if not classes:
            log.warning("Part %r has no classes; skipping training for it.", part)
            continue

        if wanted is not None and part.lower() not in wanted:
            continue

        artifact = output_dir / f"{part_key(part)}.keras"

        # Resume: a completed part is reloaded from disk rather than retrained.
        # CPU training of this dataset takes ~20 minutes in total, so an
        # interrupted run should not cost the whole thing again.
        # `only_parts` is None when no --parts flag was given, which is the
        # normal case. `part not in None` raised
        # `TypeError: argument of type 'NoneType' is not iterable`, so
        # `model export --resume` could never work. With no explicit list every
        # part is eligible for resume.
        if resume and (not only_parts or part not in only_parts):
            existing = load_trained(output_dir, part, classes)
            if existing is not None:
                log.info("Resuming: reusing existing %s model -> %s", part, artifact)
                results[part] = existing
                continue

        trained = train_part(part, classes, config, split, processed_root=processed_root)
        trained.model.save(str(artifact))
        write_sidecar(output_dir, trained)
        log.info("Saved %s model -> %s (%.1fs)", part, artifact, trained.training_seconds)
        results[part] = trained

    # ---- stage 1: the explicit Leaf-vs-Fruit router -------------------- #
    # Trained on every image in the split with the dataset's own part labels,
    # and exported as `part_router.keras`. It is a separate artefact so a
    # bundle without one still loads - `predictor` falls back to the legacy
    # heuristic in that case rather than refusing to run.
    router_wanted = wanted is None or bool(wanted & router_aliases)
    if router_enabled and router_wanted:
        router_part = "Parts"
        artifact = output_dir / f"{ROUTER_PART_KEY}.keras"
        explicit_router = bool(wanted and (wanted & router_aliases))
        # `--parts fruits` should not silently skip the router, but an explicit
        # `--parts router` must force a retrain even under `--resume`.
        existing = (
            load_trained(output_dir, router_part, router_classes)
            if resume and not explicit_router
            else None
        )
        if existing is not None:
            log.info("Resuming: reusing existing router model -> %s", artifact)
            results[router_part] = existing
        else:
            trained = train_router(config, split, processed_root=processed_root)
            trained.model.save(str(artifact))
            write_sidecar(output_dir, trained)
            log.info("Saved router model -> %s (%.1fs)", artifact, trained.training_seconds)
            results[router_part] = trained

    if not results:
        raise ValidationError("No models were trained - the dataset produced no usable parts.")
    return results
