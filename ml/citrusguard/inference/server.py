"""Long-lived JSON-lines inference server.

Why this exists
---------------
The one-shot ``worker`` imports TensorFlow and reloads every Keras model for a
single image. Measured on the development machine, that cold path is dominated
by work that does not depend on the image at all: the TensorFlow import plus
deserialising ~58 MB of hand-written ``.keras`` weights. The forward pass itself
is a small fraction of the request. Paying that cost per upload is the single
largest avoidable latency in the product.

This process keeps the interpreter and the loaded bundle warm and answers many
requests over stdin/stdout. The Next.js bridge spawns it once per Node process
(``src/lib/ml/client.ts``) and falls back to the one-shot worker if it cannot be
started, so the feature is additive: nothing that worked before stops working.

Protocol
--------
One JSON object per line, both directions. Every response echoes the request's
``id`` (when present) so the caller can correlate even if it later adds
pipelining.

    ->  {"id": "1", "op": "ping"}
    <-  {"id": "1", "ok": true, "pong": true, "loaded": []}

    ->  {"id": "2", "op": "load", "bundle_dir": "..."}
    <-  {"id": "2", "ok": true, "loaded": true}

    ->  {"id": "3", "image_path": "...", "bundle_dir": "...", ...}
    <-  {"id": "3", "ok": true, "result": {...}}

    ->  {"id": "4", "op": "shutdown"}
    <-  {"id": "4", "ok": true, "bye": true}

``op`` defaults to ``predict``. A malformed line is answered with an error and
never terminates the loop; a failed prediction is answered with the same error
body the one-shot worker would print. The process exits on EOF, ``shutdown``,
or Ctrl-C.

Read ``worker.py`` for the prediction semantics; this file is transport only.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

from ..common.errors import CitrusGuardError
from ..common.paths import get_logger
from .worker import cached_bundle_dirs, evict_bundle, load_bundle_cached, run

log = get_logger("inference.server")


def _emit(payload: dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, default=str)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _handle(request: dict[str, Any]) -> dict[str, Any] | None:
    """Dispatch one parsed request. Returns a response, or None to keep going."""
    op = str(request.get("op") or "predict")

    if op == "ping":
        return {"ok": True, "pong": True, "loaded": cached_bundle_dirs()}

    if op == "shutdown":
        return {"ok": True, "bye": True}

    if op == "load":
        bundle_dir = request.get("bundle_dir")
        if not bundle_dir:
            return {
                "ok": False,
                "error": {"code": "invalid_request", "message": "bundle_dir is required."},
            }
        started = time.perf_counter()
        load_bundle_cached(str(bundle_dir))
        elapsed = time.perf_counter() - started
        log.info("Warmed bundle %s in %.2fs", bundle_dir, elapsed)
        return {
            "ok": True,
            "loaded": True,
            "bundle_dir": str(bundle_dir),
            "warm_seconds": round(elapsed, 3),
        }

    if op == "evict":
        bundle_dir = request.get("bundle_dir")
        if not bundle_dir:
            return {
                "ok": False,
                "error": {"code": "invalid_request", "message": "bundle_dir is required."},
            }
        return {"ok": True, "evicted": evict_bundle(str(bundle_dir))}

    # Default: a prediction. Surface the same bodies the one-shot worker uses.
    started = time.perf_counter()
    try:
        response = run(request)
    except CitrusGuardError as exc:
        log.error("%s: %s", exc.code, exc.message)
        return {"ok": False, "error": exc.to_dict()}
    except Exception as exc:  # a bad request must never kill the server
        import traceback

        log.error("Unhandled inference error: %s\n%s", exc, traceback.format_exc())
        return {
            "ok": False,
            "error": {
                "code": "prediction_failed",
                "message": "Prediction failed. Please try again.",
                "detail": str(exc),
            },
        }
    response["server_seconds"] = round(time.perf_counter() - started, 4)
    return response


def serve(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="citrusguard-serve",
        description="Long-lived CitrusGuard inference server (JSON lines over stdio).",
    )
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=0.0,
        help="Exit after this many seconds without a request. 0 disables it.",
    )
    args = parser.parse_args(argv)

    last = time.monotonic()
    log.info("Inference server ready (pid=%d)", __import__("os").getpid())
    for line in sys.stdin:
        last = time.monotonic()
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit(
                {
                    "ok": False,
                    "error": {
                        "code": "invalid_request",
                        "message": "The request was not valid JSON.",
                        "detail": str(exc),
                    },
                }
            )
            continue
        if not isinstance(request, dict):
            _emit(
                {
                    "ok": False,
                    "error": {
                        "code": "invalid_request",
                        "message": "The request must be a JSON object.",
                    },
                }
            )
            continue

        response = _handle(request)
        if response is None:
            continue
        if request.get("id") is not None:
            response["id"] = request.get("id")
        _emit(response)
        if response.get("bye"):
            break

        if args.idle_timeout and (time.monotonic() - last) > args.idle_timeout:
            log.info("Exiting after %.0fs idle", args.idle_timeout)
            break

    log.info("Inference server stopped")
    return 0


def main(argv: list[str] | None = None) -> int:
    return serve(argv)


if __name__ == "__main__":
    raise SystemExit(main())
