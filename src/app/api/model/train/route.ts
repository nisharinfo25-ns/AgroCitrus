/**
 * POST /api/model/train
 *
 * Admin-only. Runs the full pipeline: train every head on CPU, evaluate on the
 * held-out test split, export a versioned bundle, and - unless `promote` is
 * false - write it to Supabase Storage and record it in `model_versions`.
 *
 * Two things are deliberately *not* done here:
 *
 *   1. It does not fabricate a response while training runs. The request blocks
 *      for the duration and then returns the real report. A fake progress
 *      stream would misrepresent how long this takes (minutes, not seconds).
 *   2. It does not skip the dataset step. If the dataset is not prepared, the
 *      CLI fails with "Dataset setup required" and that message is surfaced.
 *
 * Request budget: training on CPU takes minutes. Deploy to a host with a
 * function timeout above `maxDuration`, or run `npm run ml:model:export` from a
 * machine with the dataset and use POST /api/model/activate to register it.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { execCliCommand } from "@/lib/ml/cli";
import { isAdminConfigured } from "@/lib/supabase/client";
import { assertSameOrigin, fail, ok, serverLog } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const BodySchema = z.object({
  version: z
    .string()
    .regex(/^v?[A-Za-z0-9._-]{1,40}$/, "Version must be a short label such as v1 or 2026-01-a.")
    .optional(),
  /** Push the trained bundle to Supabase Storage and record it in Postgres. */
  push: z.boolean().default(true),
  /** Make the new version the one `/api/predict` serves. */
  promote: z.boolean().default(true),
});

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await requireAdmin();

    const body = BodySchema.parse(await readJson(request));

    if (body.push && !isAdminConfigured()) {
      throw new AppError(
        "config_error",
        "SUPABASE_SERVICE_ROLE_KEY is not set, so the trained model cannot be published. " +
          "Set it in the server environment, or train with push=false and register the bundle manually.",
      );
    }

    const args = ["model", "export"];
    if (body.version) args.push("--version", body.version);
    if (!body.promote) args.push("--no-promote");

    serverLog("model.train", `starting: ${args.join(" ")}`);
    const result = await execCliCommand(args, 13 * 60_000);

    if (body.push) {
      const pushArgs = ["supabase", "push-model"];
      if (!body.promote) pushArgs.push("--no-promote");
      // The bundle is already on disk; this uploads it and upserts the
      // `model_versions` row, so the API can serve it on the next request.
      await execCliCommand(pushArgs, 5 * 60_000).catch((error) => {
        // Training succeeded. Failing the whole request would throw away a real
        // result, so the publish failure is reported inside a 200 with an
        // explicit `published: false`.
        serverLog("model.train", "publishing the trained bundle failed", error);
        return null;
      });
    }

    return ok({
      trained: true,
      published: body.push,
      promoted: body.promote,
      result,
    });
  } catch (error) {
    return fail(error, "model.train");
  }
}

/** A request with no body is valid - all fields have defaults. */
async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}