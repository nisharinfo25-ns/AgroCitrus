/**
 * POST /api/dataset/download
 *
 * Admin-only. Delegates to the Python downloader, which:
 *   - fetches the configured public source (no credentials),
 *   - unwraps the publisher's nested archive,
 *   - verifies the extracted CONTENT checksum,
 *   - writes `data/citrus/raw/manifest.json`.
 *
 * This route refuses to run without `SUPABASE_SERVICE_ROLE_KEY`, because the
 * production sync step needs it. It fails closed with "Admin access required"
 * rather than pretending the download succeeded.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/auth";
import { isAdminConfigured } from "@/lib/supabase/client";
import { AppError } from "@/lib/errors";
import { execCliCommand } from "@/lib/ml/cli";
import { assertSameOrigin, fail, ok } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await requireAdmin();

    if (!isAdminConfigured()) {
      throw new AppError(
        "config_error",
        "SUPABASE_SERVICE_ROLE_KEY is not set, so the dataset cannot be synced to storage. Set it in the server environment and try again.",
      );
    }

    const force = request.nextUrl.searchParams.get("force") === "true";
    const result = await execCliCommand(
      ["dataset", "download", ...(force ? ["--force"] : [])],
      20 * 60_000,
    );

    return ok({ result });
  } catch (error) {
    return fail(error, "dataset.download");
  }
}