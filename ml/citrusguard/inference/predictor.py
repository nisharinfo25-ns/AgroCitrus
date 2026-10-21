"""Model inference: two-stage Leaf/Fruit -> disease classification.

The pipeline mirrors the dataset layout exactly:

    stage 1  part model   : Leaf vs Fruit
    stage 2  leaf model   : leaf disease classes   (only if stage 1 says Leaf)
             fruit model  : fruit disease classes  (only if stage 1 says Fruit)

Every number returned here - confidence, class probabilities, severity
availability - comes from the model or from the exported config. Nothing is
hardcoded, and no class name is ever invented: ``classes`` originates from the
dataset scan and is carried through export into ``config.json``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..common.errors import ModelLoadError, ModelNotConfiguredError, PredictionError
from ..common.paths import get_logger
from ..config.loader import model_config
from ..dataset.preprocessor import decode_image, preprocess_for_inference
from . import gradcam as gradcam_mod
from .image_quality import QualityReport, analyse as analyse_quality, assess_image

log = get_logger("inference.predictor")

# Canonical part keys. The folder names come from the dataset config; these are
# the *model head* names, which are ours to choose.
PART_LEAF = "part_leaf"
PART_FRUIT = "part_fruit"
# Artifact key of the stage-1 Leaf-vs-Fruit router. Present only in bundles
# exported with `routing.enabled: true`; `predict_image` falls back to the
# legacy peak-softmax heuristic when it is absent and says so in
# `routing_state`, so an older bundle keeps working instead of failing to load.
ROUTER_PART_KEY = "part_router"


@dataclass
class Probability:
    class_name: str
    probability: float


@dataclass
class PredictionResult:
    input_type: str | None
    input_type_confidence: float | None
    predicted_class: str
    predicted_class_display: str
    confidence: float
    # `None` when the pipeline refused to issue a verdict (routing uncertain).
    status: str | None
    is_low_confidence: bool
    min_confidence_threshold: float
    probabilities: list[Probability] = field(default_factory=list)
    part_probabilities: list[Probability] = field(default_factory=list)
    # Stage-1 routing provenance. `routing_state` is one of:
    #   "ok"         - a trained router decided, above its threshold
    #   "uncertain"  - a trained router scored below its threshold; NO disease
    #                  head was run and NO Grad-CAM was produced
    #   "heuristic"  - the bundle has no router, so the legacy peak-softmax
    #                  comparison was used (see README limitations)
    #   "config_only"- a single-head bundle, so the part came from the config
    routing_state: str = "ok"
    routing_method: str | None = None
    min_routing_confidence: float | None = None
    routing_message: str | None = None
    quality: QualityReport | None = None
    severity: str | None = None
    severity_supported: bool = False
    severity_unavailable_reason: str | None = None
    gradcam: dict[str, Any] | None = None
    model_name: str = ""
    model_version: str = ""
    dataset_version: str = ""
    explanation_note: str = ""
    latency_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "input_type": self.input_type,
            "input_type_confidence": self.input_type_confidence,
            # Explicit aliases: routing confidence and disease confidence are
            # two different measurements from two different models and must
            # never be presented as one number.
            "routing_state": self.routing_state,
            "routing_confidence": self.input_type_confidence,
            "routing_threshold": self.min_routing_confidence,
            "routing_method": self.routing_method,
            "routing_message": self.routing_message,
            "prediction_confidence": self.confidence,
            "predicted_class": self.predicted_class,
            "predicted_class_display": self.predicted_class_display,
            "confidence": self.confidence,
            "status": self.status,
            "is_low_confidence": self.is_low_confidence,
            "min_confidence_threshold": self.min_confidence_threshold,
            "probabilities": [
                {"class_name": p.class_name, "probability": p.probability}
                for p in self.probabilities
            ],
            "part_probabilities": [
                {"class_name": p.class_name, "probability": p.probability}
                for p in self.part_probabilities
            ],
            "quality": self.quality.to_dict() if self.quality else None,
            "severity": self.severity,
            "severity_supported": self.severity_supported,
            "severity_unavailable_reason": self.severity_unavailable_reason,
            "gradcam": self.gradcam,
            "model_name": self.model_name,
            "model_version": self.model_version,
            "dataset_version": self.dataset_version,
            "explanation_note": self.explanation_note,
            "latency_ms": self.latency_ms,
        }


# --------------------------------------------------------------------------- #
# Display naming
# --------------------------------------------------------------------------- #
# Maps a raw dataset folder name to a human label. Keys are the folder names
# present in the published archive; anything else falls back to title-casing so
# an unexpected class still displays sensibly rather than being dropped.
_DISPLAY_OVERRIDES = {
    "black spot": "Black Spot",
    "canker": "Canker",
    "greening": "Greening (Huanglongbing)",
    "melanose": "Melanose",
    "scab": "Scab",
    "healthy": "Healthy",
}


def display_name(raw: str) -> str:
    key = raw.strip().lower()
    if key in _DISPLAY_OVERRIDES:
        return _DISPLAY_OVERRIDES[key]
    return raw.replace("_", " ").replace("-", " ").strip().title()


def normalise_class(raw: str) -> str:
    """Stable machine key stored in PostgreSQL and compared in the UI."""
    return "_".join(raw.strip().lower().replace("-", " ").split())


def part_key_to_input_type(part_key: str) -> str | None:
    """Map a bundle head key to the app's ``InputType``."""
    normalised = normalise_class(part_key)
    if normalised.endswith("leaf"):
        return "leaf"
    if normalised.endswith("fruit"):
        return "fruit"
    return None


def is_healthy(class_name: str) -> bool:
    return class_name.strip().lower() == "healthy"


# --------------------------------------------------------------------------- #
# Model bundle
# --------------------------------------------------------------------------- #
class ModelBundle:
    """A loaded, validated set of Keras models plus their exported config."""

    def __init__(self, config: dict[str, Any], models: dict[str, Any]) -> None:
        self.config = config
        self.models = models

    # -- construction ----------------------------------------------------- #
    @classmethod
    def load(cls, bundle_dir: str | Path) -> "ModelBundle":
        bundle_dir = Path(bundle_dir)
        config_path = bundle_dir / "config.json"
        if not config_path.is_file():
            raise ModelNotConfiguredError(
                "Model is not configured. Train a model or deploy a production "
                "version before running predictions.",
                detail=f"missing {config_path}",
            )
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ModelLoadError("Model config.json is not valid JSON.", detail=str(exc)) from exc

        if not config.get("classes_by_part"):
            raise ModelNotConfiguredError(
                "Model is not configured. The exported model config declares no "
                "classes, which means the dataset was never scanned.",
                detail="config.classes_by_part is empty",
            )

        import tensorflow as tf  # imported lazily: unit tests must not need TF

        models: dict[str, Any] = {}
        for key, filename in (config.get("artifacts") or {}).items():
            artifact = bundle_dir / filename
            if not artifact.is_file():
                raise ModelNotConfiguredError(
                    f"Model artifact for '{key}' is missing from the deployed bundle.",
                    detail=str(artifact),
                )
            try:
                models[key] = tf.keras.models.load_model(str(artifact), compile=False)
            except Exception as exc:
                raise ModelLoadError(
                    f"Failed to load the '{key}' model artifact.", detail=str(exc)
                ) from exc
            log.info("Loaded model head '%s' from %s", key, artifact.name)

        if not models:
            raise ModelNotConfiguredError("No model artifacts were found in the bundle.")
        return cls(config, models)

    # -- accessors -------------------------------------------------------- #
    def _config_value(self, key: str, default: Any = None) -> Any:
        """
        Read one value out of the bundle manifest, accepting either shape.

        `export.py` writes a FLAT manifest: `input_size`, `preprocessing_method`
        and `min_confidence` sit at the top level, beside `classes_by_part` and
        `artifacts`. These accessors used to read `config["model"][...]`, which
        is the NESTED `model.yaml` shape, so on a real bundle every one of them
        raised `KeyError: 'model'` - both `.keras` heads loaded successfully and
        then inference died on the first call to `.input_size`, before a single
        forward pass. The deployed `config.json` is the authority on the format,
        and it is flat.

        The nested shape is still accepted so a bundle written by a different
        exporter version keeps loading, but the flat value wins whenever both are
        present.
        """
        if key in self.config:
            value = self.config[key]
            if value is not None:
                return value
        section = self.config.get("model")
        if isinstance(section, dict):
            value = section.get(key)
            if value is not None:
                return value
        return default

    @property
    def input_size(self) -> tuple[int, int]:
        value = self._config_value("input_size")
        if not isinstance(value, (list, tuple)) or len(value) < 2:
            # Falling back to model.yaml would preprocess at a different
            # resolution than the weights were trained at. Refuse instead.
            raise ModelNotConfiguredError(
                "The deployed model config declares no input size, so the "
                "preprocessing pipeline cannot be built.",
                detail=f"config.input_size is missing or malformed: {value!r}",
            )
        return int(value[0]), int(value[1])

    @property
    def preprocessing_method(self) -> str:
        return str(self._config_value("preprocessing_method") or "mobilenet_v2_imagenet")

    @property
    def classes_by_part(self) -> dict[str, list[str]]:
        return {k: list(v) for k, v in self.config["classes_by_part"].items()}

    @property
    def min_confidence(self) -> float:
        # The manifest records the threshold the bundle was exported with. It
        # used to be read from a non-existent `inference` block, so a promoted
        # bundle's own `min_confidence` was ignored in favour of whatever
        # model.yaml happened to say at serving time.
        value = self._config_value("min_confidence")
        if value is None:
            value = model_config()["inference"]["min_confidence"]
        return float(value)

    @property
    def severity_support(self) -> dict[str, Any]:
        return self.config.get("severity_support", {"enabled": False})

    @property
    def has_router(self) -> bool:
        """Whether this bundle ships a trained stage-1 Leaf-vs-Fruit router."""
        return ROUTER_PART_KEY in self.models

    @property
    def routing_config(self) -> dict[str, Any]:
        """Stage-1 settings, read from the BUNDLE rather than from model.yaml.

        A bundle exported before the router existed has no `routing` key at
        all, and one exported with routing disabled has `routing: null`. Both
        mean "no trained router here", which is a supported state: the
        predictor falls back to the legacy heuristic and reports
        `routing_state="heuristic"` instead of failing to load.
        """
        value = self._config_value("routing")
        return value if isinstance(value, dict) else {}

    @property
    def routing_classes(self) -> list[str]:
        routing = self.routing_config
        classes = [str(c) for c in (routing.get("classes") or ["leaf", "fruit"])]
        if len(classes) != 2 or len(set(classes)) != 2:
            raise ModelNotConfiguredError(
                "The deployed model declares an unusable routing class list.",
                detail=f"routing.classes = {classes!r}",
            )
        return classes

    @property
    def min_routing_confidence(self) -> float:
        """Abstention threshold below which stage 1 refuses to decide.

        Taken from the bundle first: a promoted model must be reproducible from
        its own manifest, not from whatever `model.yaml` says on the machine
        that happens to be serving it.
        """
        value = self.routing_config.get("min_confidence")
        if value is None:
            value = (model_config().get("routing") or {}).get("min_confidence", 0.95)
        return float(value)

    @property
    def version(self) -> str:
        return str(self.config.get("model_version", "unknown"))

    @property
    def name(self) -> str:
        return str(self.config.get("model_name", "citrusguard-cnn"))

    @property
    def dataset_version(self) -> str:
        return str(self.config.get("dataset_version", "unknown"))

    def classes_for(self, part_key: str) -> list[str]:
        if part_key not in self.classes_by_part:
            raise ModelNotConfiguredError(
                f"This model has no classifier for input type '{part_key}'.",
                detail=f"available: {list(self.classes_by_part)}",
            )
        return self.classes_by_part[part_key]


# --------------------------------------------------------------------------- #
# Prediction
# --------------------------------------------------------------------------- #
def _softmax(vector: np.ndarray) -> np.ndarray:
    shifted = vector - np.max(vector)
    exponentiated = np.exp(shifted)
    return exponentiated / np.sum(exponentiated)


def _head_ends_in(model: Any, activation_name: str) -> bool:
    """Whether the head's final layer already applies ``activation_name``.

    Both CitrusGuard heads are `Dense(n, activation="softmax")`, so their output
    is a probability distribution, not logits. Calling `_softmax` on it again is
    what pinned every confidence near 0.40 and tied the other classes at ~0.1489.
    Inspect the layer rather than guessing from the values, so a future
    logit-output head still gets a softmax.
    """
    try:
        layers = list(getattr(model, "layers", []) or [])
        activation = getattr(layers[-1], "activation", None) if layers else None
    except (AttributeError, IndexError, TypeError):
        return False
    return getattr(activation, "__name__", "") == activation_name


def _predict_probs(model: Any, batch: np.ndarray) -> np.ndarray:
    output = model.predict(batch, verbose=0)
    if isinstance(output, list):
        output = output[0]
    output = np.asarray(output, dtype=np.float64)
    if output.ndim == 1:
        output = np.expand_dims(output, axis=0)
    if output.shape[-1] == 1:  # sigmoid head -> binary
        p = float(np.clip(output.ravel()[0], 0.0, 1.0))
        return np.array([[1.0 - p, p]], dtype=np.float64)
    if _head_ends_in(model, "softmax"):
        # Already probabilities. Only renormalise, to shed float32 drift, and
        # never re-softmax: softmax([0.998883, 0.001106, ...]) is [0.404273,
        # 0.149055, ...].
        clipped = np.clip(output, 0.0, None)
        totals = clipped.sum(axis=-1, keepdims=True)
        return clipped / np.where(totals > 0.0, totals, 1.0)
    # `[None, :]` keeps the (1, n) batch axis. `_softmax` reduces to 1-D, and
    # returning it bare made this function shape-inconsistent: the sigmoid branch
    # above returned (1, 2) while the softmax branch returned (n,). Every caller
    # then does `probs[0]`, which on a 1-D array is a numpy scalar rather than the
    # probability row - so `zip(classes, probs[0])` raised
    # `TypeError: 'numpy.float64' object is not iterable` on every prediction.
    return _softmax(output[0].astype(np.float64))[np.newaxis, :]


def predict_image(
    image_source: str | Path | bytes,
    bundle: ModelBundle,
    *,
    quality_report: QualityReport | None = None,
    explain_dir: Path | None = None,
    enable_gradcam: bool = True,
    part_hint: str | None = None,
) -> PredictionResult:
    """Run the full two-stage pipeline over one image.

    The caller is expected to have already run (and enforced) the image-quality
    gate; ``quality_report`` is passed straight through to the result so the UI
    can show the measurements.

    ``part_hint`` is an explicit "leaf"/"fruit" chosen by the person uploading
    the image (e.g. after the router abstained). It takes precedence over the
    router and is recorded as ``routing_state="user_selected"`` so the result
    never claims a classifier decided something the user did.
    """
    import time

    started = time.perf_counter()
    batch = preprocess_for_inference(
        image_source,
        input_size=bundle.input_size,
        preprocessing_method=bundle.preprocessing_method,
    )
    original = decode_image(image_source)
    quality = quality_report or analyse_quality(original)

    # ---- stage 1: Leaf vs Fruit --------------------------------------- #
    # Preferred path: a DEDICATED binary router trained on every image in the
    # dataset, labelled by the dataset's own part folders. It scores leaf-vs-
    # fruit directly, so nothing about disease classes is asked to double as a
    # part detector.
    #
    # Legacy path (bundle has no `part_router` artifact): both disease heads
    # are run and each is scored by its peak softmax, then normalised into a
    # two-way distribution. That comparison puts two quantities measured over
    # DIFFERENT label spaces on one scale, and the leaf head - trained on ~4x
    # more images and therefore systematically sharper - wins for most fruit
    # photographs. It is kept only so an older bundle still serves, and it
    # reports itself as `routing_state="heuristic"` rather than presenting the
    # decision as trained.
    input_type: str | None = None
    input_type_confidence: float | None = None
    part_probs: list[Probability] = []
    routing_state = "config_only"
    routing_method = "config_only"
    routing_threshold: float | None = None
    routing_message: str | None = None

    explicit_part = str(part_hint).strip().lower() if part_hint else ""
    if explicit_part and explicit_part not in ("leaf", "fruit"):
        raise PredictionError(
            "The requested input type must be 'leaf' or 'fruit'.",
            detail=f"part_hint={part_hint!r}",
        )

    if explicit_part:
        # The caller told us what this is. Honour it, record that a human chose
        # it, and do not run the router: presenting the router's opinion here
        # would imply a measurement that the choice already overrode. The user
        # is in control, and the response says so.
        input_type = explicit_part
        routing_state = "user_selected"
        routing_method = "user_selected"
    elif bundle.has_router:
        routing_threshold = bundle.min_routing_confidence
        router_classes = bundle.routing_classes
        router_probs = _predict_probs(bundle.models[ROUTER_PART_KEY], batch)[0]
        if int(router_probs.shape[0]) != len(router_classes):
            raise ModelLoadError(
                "The Leaf-vs-Fruit router output size does not match its declared "
                "class list. The model config appears inconsistent with the artifact."
            )
        best_router = int(np.argmax(router_probs))
        input_type_confidence = float(router_probs[best_router])
        part_probs = [
            Probability(class_name=display_name(name), probability=float(router_probs[index]))
            for index, name in sorted(
                enumerate(router_classes), key=lambda pair: router_probs[pair[0]], reverse=True
            )
        ]
        routing_method = "trained_router"
        if input_type_confidence < routing_threshold:
            # Abstain. Running a disease head anyway would turn a guess into a
            # measurement, and Grad-CAM would then explain a class the routing
            # stage never endorsed - so neither is produced.
            routing_state = "uncertain"
            routing_message = (
                "Unable to confidently determine whether this is a citrus leaf or "
                "fruit. Please upload a clearer, closer image of a single citrus "
                "leaf or fruit."
            )
        else:
            routing_state = "ok"
            input_type = str(router_classes[best_router])
    elif PART_LEAF in bundle.models and PART_FRUIT in bundle.models:
        head_scores: dict[str, tuple[float, np.ndarray, list[str]]] = {}
        for head_key in (PART_LEAF, PART_FRUIT):
            head_probs = _predict_probs(bundle.models[head_key], batch)
            head_classes = bundle.classes_for(head_key)
            if len(head_classes) != head_probs.shape[-1]:
                raise ModelLoadError(
                    f"The '{head_key}' classifier output size does not match "
                    "its class list. The model config appears inconsistent "
                    "with the artifact."
                )
            head_scores[head_key] = (float(np.max(head_probs)), head_probs, head_classes)

        leaf_score = head_scores[PART_LEAF][0]
        fruit_score = head_scores[PART_FRUIT][0]
        total = leaf_score + fruit_score
        leaf_p = (leaf_score / total) if total > 0 else 0.5
        fruit_p = (fruit_score / total) if total > 0 else 0.5
        part_probs = [
            Probability(class_name="Leaf", probability=leaf_p),
            Probability(class_name="Fruit", probability=fruit_p),
        ]
        routing_state = "heuristic"
        routing_method = "legacy_peak_softmax"
        input_type = "leaf" if leaf_p >= fruit_p else "fruit"
        input_type_confidence = max(leaf_p, fruit_p)
    else:
        # Single-head bundle: the part is read from the config, not inferred.
        head_keys = [k for k in bundle.models if k != ROUTER_PART_KEY]
        if not head_keys:
            raise ModelNotConfiguredError(
                "The deployed model bundle contains no disease classifier.",
                detail="config.artifacts is empty",
            )
        input_type = part_key_to_input_type(head_keys[0])
        input_type_confidence = 1.0 if input_type else None

    # ---- abstention ----------------------------------------------------- #
    if routing_state == "uncertain":
        return PredictionResult(
            input_type=None,
            input_type_confidence=input_type_confidence,
            predicted_class="unclassified",
            predicted_class_display="Not analysed",
            confidence=0.0,
            status=None,
            is_low_confidence=True,
            min_confidence_threshold=bundle.min_confidence,
            probabilities=[],
            part_probabilities=part_probs,
            routing_state=routing_state,
            routing_method=routing_method,
            min_routing_confidence=routing_threshold,
            routing_message=routing_message,
            quality=quality,
            severity=None,
            severity_supported=bool(bundle.severity_support.get("enabled", False)),
            severity_unavailable_reason=str(
                bundle.severity_support.get("reason")
                or "Severity analysis is not available for this model."
            ),
            gradcam=None,
            model_name=bundle.name,
            model_version=bundle.version,
            dataset_version=bundle.dataset_version,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    # ---- stage 2: the specialised disease head ------------------------- #
    head_keys = [k for k in (PART_LEAF, PART_FRUIT) if k in bundle.models]
    if not head_keys:
        # Single-head (or differently-named) bundle: use whatever it has.
        head_keys = [k for k in bundle.models if k != ROUTER_PART_KEY]
    if not head_keys:
        raise ModelNotConfiguredError(
            "The deployed model bundle contains no disease classifier.",
            detail="config.artifacts contains only a router",
        )

    if input_type is not None:
        wanted_key = PART_FRUIT if input_type == "fruit" else PART_LEAF
        selected_key = wanted_key if wanted_key in head_keys else head_keys[0]
    else:
        selected_key = head_keys[0]
    selected_model = bundle.models[selected_key]
    selected_classes = bundle.classes_for(selected_key)

    disease_probs = _predict_probs(selected_model, batch)
    if len(selected_classes) != disease_probs.shape[-1]:
        raise ModelLoadError(
            f"The '{selected_key}' classifier output size does not match "
            "its class list. The model config appears inconsistent "
            "with the artifact."
        )

    # ---- stage 3: the winning disease class ---------------------------- #
    best_index = int(np.argmax(disease_probs[0]))
    predicted_raw = selected_classes[best_index]
    confidence = float(disease_probs[0][best_index])
    threshold = bundle.min_confidence

    probabilities = [
        Probability(class_name=display_name(c), probability=float(p))
        for c, p in sorted(
            zip(selected_classes, disease_probs[0]), key=lambda pair: pair[1], reverse=True
        )
    ]

    all_scores_str = ", ".join(f"{c}: {p:.4f}" for c, p in zip(selected_classes, disease_probs[0]))
    log.info(
        "Inference diagnostics: bundle_version=%s head=%s input_shape=%s prep=%s "
        "pred_idx=%d pred_class=%s conf=%.4f scores=[%s]",
        bundle.version,
        selected_key,
        batch.shape,
        bundle.preprocessing_method,
        best_index,
        predicted_raw,
        confidence,
        all_scores_str,
    )

    # ---- explainability -------------------------------------------------- #
    gradcam_payload: dict[str, Any] | None = None
    if enable_gradcam and explain_dir is not None:
        try:
            cam = gradcam_mod.compute(
                selected_model,
                batch,
                original,
                explain_dir,
                stem=normalise_class(predicted_raw),
                target_class_index=best_index,
            )
            gradcam_payload = {
                "heatmap_path": cam.heatmap_path,
                "overlay_path": cam.overlay_path,
                "target_layer": cam.target_layer,
                "regions": cam.top_contributing_regions,
                "summary": gradcam_mod.format_regions(cam.top_contributing_regions),
                "disclaimer": (
                    "The highlighted regions represent areas that contributed "
                    "strongly to the model's prediction. This visualisation is an "
                    "explanation aid, not a medical or agricultural diagnosis, and "
                    "it does not prove that a disease is present."
                ),
            }
        except Exception as exc:  # explanation must never break a prediction
            log.warning("Grad-CAM failed for this request: %s", exc)
            gradcam_payload = {
                "heatmap_path": None,
                "overlay_path": None,
                "error": "The attention visualisation could not be generated for this image.",
            }

    severity_cfg = bundle.severity_support
    severity_enabled = bool(severity_cfg.get("enabled", False))
    severity_reason = None
    if not severity_enabled:
        severity_reason = str(
            severity_cfg.get("reason")
            or "Severity analysis is not available for this model."
        )

    result = PredictionResult(
        input_type=input_type,
        input_type_confidence=input_type_confidence,
        predicted_class=normalise_class(predicted_raw),
        predicted_class_display=display_name(predicted_raw),
        confidence=round(confidence, 6),
        status="healthy" if is_healthy(predicted_raw) else "diseased",
        is_low_confidence=confidence < threshold,
        min_confidence_threshold=threshold,
        probabilities=probabilities,
        part_probabilities=part_probs,
        routing_state=routing_state,
        routing_method=routing_method,
        min_routing_confidence=routing_threshold,
        routing_message=routing_message,
        quality=quality,
        # Never derived from confidence.
        severity=None,
        severity_supported=severity_enabled,
        severity_unavailable_reason=severity_reason,
        gradcam=gradcam_payload,
        model_name=bundle.name,
        model_version=bundle.version,
        dataset_version=bundle.dataset_version,
        latency_ms=int((time.perf_counter() - started) * 1000),
    )
    log.info(
        "Predicted %s (%.4f) as %s in %dms [routing=%s method=%s confidence=%s]",
        result.predicted_class,
        result.confidence,
        result.input_type or "unknown-part",
        result.latency_ms,
        result.routing_state,
        result.routing_method,
        "n/a" if input_type_confidence is None else f"{input_type_confidence:.4f}",
    )
    return result
