"""Dataset management: download, validate, split, preprocess."""

from .downloader import DownloadResult, download_and_extract, download_archive, is_downloaded, sha256_file
from .preprocessor import (
    build_train_augmenter,
    decode_image,
    normalize_uint8,
    preprocess_for_inference,
    preprocessed_copy,
    resize_rgb,
    to_rgb_uint8,
)
from .splitter import SplitResult, load_split, split_dataset
from .validator import (
    DiscoveredLayout,
    discover_layout,
    iter_images,
    manifest_path,
    read_manifest,
    verify,
    write_manifest,
)

__all__ = [
    "DiscoveredLayout",
    "DownloadResult",
    "SplitResult",
    "build_train_augmenter",
    "decode_image",
    "discover_layout",
    "download_and_extract",
    "download_archive",
    "is_downloaded",
    "iter_images",
    "load_split",
    "manifest_path",
    "normalize_uint8",
    "preprocess_for_inference",
    "preprocessed_copy",
    "read_manifest",
    "resize_rgb",
    "sha256_file",
    "split_dataset",
    "to_rgb_uint8",
    "verify",
    "write_manifest",
]
