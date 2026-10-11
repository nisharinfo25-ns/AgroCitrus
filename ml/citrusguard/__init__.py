"""CitrusGuard - dataset management, training and explainable inference.

The package is intentionally framework-light and side-effect free on import so
that every module can be imported from a unit test without touching the
filesystem, the network or TensorFlow.
"""

__version__ = "1.0.0"
__all__ = ["__version__"]
