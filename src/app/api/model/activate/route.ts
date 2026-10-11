/**
 * POST /api/model/activate
 *
 * Admin-only. Promotes an already-exported bundle to production.
 *
 * "Activate" is intentionally *not* the same as "train". It assumes the model
 * was trained elsewhere (a CI job, a workstation, a teammate's laptop) and
 * registers that exact artifact. That is the honest way to deploy a model:
 * the bytes that were evaluated are the bytes that ship.
 *
 * What it does, in order:
 *   1. `citrusguard model promote <version>` - copies the versioned bundle into
 *      `models/production/` and re-verifies its checksums;
 *   2. `citrusguard supabase push-model` - uploads to the private
 *      `trained-models/production/` prefix and upserts `model_versions`.
 *
 * Only after both succeed is the version `status = 'production'` in Postgres,
 * and every other version is demoted in the same transaction (the SQL function
 * `activate_model_version()` in 0001_core_schema.sql does this).
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
export const maxDuration = 300;

const BodySchema = z.object({
  version: z
    .string()
    .regex(/^v?[A-Za-z0-9._-]{1,40}$/)
    .describe("The version label to promote, e.g. v1."),
});

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await requireAdmin();

    if (!isAdminConfigured()) {
      throw new AppError(
        "config_error",
        "SUPABASE_SERVICE_ROLE_KEY is not set, so a model cannot be activated. " +
          "Set it in the server environment.",
      );
    }

    const { version } = BodySchema.parse(await request.json());

    const promoted = await execCliCommand(["model", "promote", version], 5 * 60_000);

    const pushed = await execCliCommand(["supabase", "push-model"], 5 * 60_000).catch((error) => {
      // Promotion on disk succeeded. Report that honestly instead of claiming
      // the whole activation failed.
      serverLog("model.activate", `bundle promoted locally but upload failed`, error);
      return null;
    });

    return ok({
      version,
      promoted: true,
      published: Boolean(pushed),
      // If publishing failed, the version is live on this machine but not yet
      // visible to any other instance. That distinction matters operationally.
      message: pushed
        ? `Model ${version} is now the production model.`
        : `Model ${version} was promoted on this server but could not be uploaded to Supabase Storage, so other instances are still serving the previous version. See the server logs.`,
      local: promoted,
      storage: pushed,
    });
  } catch (error) {
    return fail(error, "model.activate");
  }
}