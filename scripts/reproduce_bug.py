"""
Reproduce the Canker->Greening bug.
Run the full inference pipeline on actual Canker images from the test set
and print exactly what the model predicts.
"""
import sys
import json
import numpy as np
from pathlib import Path

PROJ = Path("C:/Users/NISHAR AHAMED N/Desktop/Mini Project")
sys.path.insert(0, str(PROJ / "ml"))

import tensorflow as tf
tf.get_logger().setLevel("ERROR")

from citrusguard.inference.predictor import ModelBundle, predict_image, _predict_probs, _head_ends_in
from citrusguard.dataset.preprocessor import preprocess_for_inference

PROD_DIR = PROJ / "models" / "production"
PROCESSED_DIR = PROJ / "data" / "citrus" / "processed"


def run_full_pipeline_on_images(image_paths: list[Path], true_label: str, bundle: ModelBundle, part_hint: str = None) -> None:
    print(f"\n=== Testing {len(image_paths)} '{true_label}' images (hint={part_hint or 'auto'}) ===")
    for img_path in image_paths[:5]:  # test first 5
        try:
            result = predict_image(img_path, bundle, enable_gradcam=False, part_hint=part_hint)
            top3 = result.probabilities[:3]
            top3_str = ", ".join(f"{p.class_name}={p.probability:.3f}" for p in top3)
            status = "OK" if result.predicted_class_display == true_label else "WRONG"
            print(f"  [{status}] {img_path.name}: predicted={result.predicted_class_display} ({result.confidence:.3f}) | top3: {top3_str}")
            print(f"         routing: {result.routing_state}/{result.routing_method}, input_type={result.input_type}")
        except Exception as e:
            print(f"  [ERR] {img_path.name}: {e}")


def inspect_raw_model_output(image_path: Path, bundle: ModelBundle) -> None:
    """Show raw model output probabilities for all heads."""
    batch = preprocess_for_inference(image_path, input_size=bundle.input_size, preprocessing_method=bundle.preprocessing_method)
    print(f"\n  Raw outputs for: {image_path.name}")
    print(f"  Input batch shape: {batch.shape}, dtype={batch.dtype}, range=[{batch.min():.3f},{batch.max():.3f}]")
    for head_key, model in bundle.models.items():
        if head_key == "part_router":
            classes = bundle.routing_classes
        else:
            classes = bundle.classes_for(head_key)
        raw_out = model.predict(batch, verbose=0)
        probs = np.array(raw_out).ravel()
        already_softmax = _head_ends_in(model, "softmax")
        print(f"  [{head_key}] already_softmax={already_softmax} output_sum={probs.sum():.4f}")
        for i, (cls, p) in enumerate(zip(classes, probs)):
            marker = " <-- TOP" if i == np.argmax(probs) else ""
            print(f"    [{i}] {cls}: {p:.6f}{marker}")


if __name__ == "__main__":
    print("Loading production bundle...")
    bundle = ModelBundle.load(str(PROD_DIR))
    print(f"Bundle loaded: version={bundle.version}, has_router={bundle.has_router}")
    print(f"classes_by_part: {json.dumps(bundle.classes_by_part, indent=2)}")
    print(f"preprocessing_method: {bundle.preprocessing_method}")
    print(f"min_confidence: {bundle.min_confidence}")

    # Find Canker test images (Leaves)
    leaf_canker_test = sorted((PROCESSED_DIR / "leaves/test/Canker").glob("*")) if (PROCESSED_DIR / "leaves/test/Canker").exists() else []
    leaf_greening_test = sorted((PROCESSED_DIR / "leaves/test/Greening").glob("*")) if (PROCESSED_DIR / "leaves/test/Greening").exists() else []
    fruit_canker_test = sorted((PROCESSED_DIR / "fruits/test/Canker").glob("*")) if (PROCESSED_DIR / "fruits/test/Canker").exists() else []
    fruit_greening_test = sorted((PROCESSED_DIR / "fruits/test/Greening").glob("*")) if (PROCESSED_DIR / "fruits/test/Greening").exists() else []

    print(f"\nFound test images: leaf/Canker={len(leaf_canker_test)}, leaf/Greening={len(leaf_greening_test)}, fruit/Canker={len(fruit_canker_test)}, fruit/Greening={len(fruit_greening_test)}")

    # First: inspect raw model output for one Canker leaf image
    if leaf_canker_test:
        print("\n====== RAW MODEL OUTPUTS ======")
        inspect_raw_model_output(leaf_canker_test[0], bundle)

    if fruit_canker_test:
        inspect_raw_model_output(fruit_canker_test[0], bundle)

    # Run full pipeline
    run_full_pipeline_on_images(leaf_canker_test, "Canker", bundle)
    run_full_pipeline_on_images(leaf_greening_test, "Greening (Huanglongbing)", bundle)
    run_full_pipeline_on_images(fruit_canker_test, "Canker", bundle)
    run_full_pipeline_on_images(fruit_greening_test, "Greening (Huanglongbing)", bundle)

    # Now force-test with explicit part hints to isolate routing vs model issue
    if leaf_canker_test:
        run_full_pipeline_on_images(leaf_canker_test, "Canker", bundle, part_hint="leaf")
    if fruit_canker_test:
        run_full_pipeline_on_images(fruit_canker_test, "Canker", bundle, part_hint="fruit")
