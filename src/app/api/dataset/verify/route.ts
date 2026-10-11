/**
 * POST /api/dataset/verify
 *
 * Admin-only. Re-reads every image on disk, recomputes the deterministic
 * content checksum and re-checks the class layout against `dataset.yaml`.
 *
 * The checksum policy is deliberate: the publisher re-packages the archive on
 * every request, so the *archive* SHA-256 is not reproducible and is therefore
 * not what integrity is judged on. What is stable is the extracted content, and
 * that is what gets hashed (see `ml/citrusguard/dataset/validator.py`).
 */

import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { execCliCommand, execCliStatus } from "@/lib/ml/cli";
import { assertSameOrigin, fail, ok, serverLog } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await requireAdmin();

    const status = await execCliStatus<{ manifest?: unknown }>(["dataset", "status"]);
    if (!status.manifest) {
      throw new AppError(
        "dataset_setup_required",
        "Dataset setup required. Nothing has been downloaded yet, so there is nothing to verify.",
      );
    }

    try {
      const result = await execCliCommand(["dataset", "verify"], 15 * 60_000);
      return ok(result);
    } catch (error) {
      // A failed verification is a legitimate, reportable outcome - the CLI
      // exits non-zero and prints a structured report. Surface it as 409 with
      // the report attached rather than an opaque 500.
      serverLog("dataset.verify", "verification reported a problem", error);
      throw new AppError(
        "dataset_validation_failed",
        "The dataset did not pass verification. Check the report for which files or classes failed.",
        error instanceof Error ? { detail: error.message } : undefined,
      );
    }
  } catch (error) {
    return fail(error, "dataset.verify");
  }
}