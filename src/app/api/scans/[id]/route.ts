/**
 * GET    /api/scans/:id   - one scan, with freshly signed image URLs
 * DELETE /api/scans/:id   - delete a scan and every artefact it owns
 *
 * Both handlers authorise through RLS by reading the row with the caller's
 * scoped client *before* touching anything. Asking for another user's scan id
 * therefore returns 404, not 403: the row is not visible, so its existence is
 * not confirmed either.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { deleteScan, deleteScanFiles, getScan, isUuid, signScanImages } from "@/lib/db/scans";
import { AppError } from "@/lib/errors";
import { ensureProductionBundle } from "@/lib/ml/client";
import { createAdminClient } from "@/lib/supabase/client";
import { assertSameOrigin, fail, noContent, ok } from "@/lib/server";
import type { ScanWithUrls } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string() });

/**
 * Next.js 15 delivers `params` as a promise of the raw segment map. The zod
 * schema validates it at runtime; the type stays the raw shape so a schema
 * change cannot silently desync the declared type from what is parsed.
 */
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = ParamsSchema.parse(await context.params);
    if (!isUuid(id)) {
      throw new AppError("not_found", "That scan does not exist.");
    }

    const { user, supabase } = await requireUser();
    const scan = await getScan(supabase, id);

    if (!scan) {
      throw new AppError("not_found", "That scan does not exist, or it is not yours.");
    }

    const admin = createAdminClient();
    const urls = await signScanImages(admin, scan);
    const body: ScanWithUrls = { ...scan, ...urls };

    return ok({ scan: body }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fail(error, "scans.get");
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);

    const { id } = ParamsSchema.parse(await context.params);
    if (!isUuid(id)) {
      throw new AppError("not_found", "That scan does not exist.");
    }

    const { user, supabase } = await requireUser();

    // Read first so the storage cleanup knows the owner. RLS makes this null
    // for anyone else's row, which is how authorisation is enforced here.
    const scan = await getScan(supabase, id);
    if (!scan) {
      throw new AppError("not_found", "That scan does not exist, or it is not yours.");
    }

    const admin = createAdminClient();
    await deleteScanFiles(admin, scan.user_id, scan.id);

    const deleted = await deleteScan(supabase, id);
    if (!deleted) {
      throw new AppError("not_found", "That scan does not exist, or it is not yours.");
    }

    return noContent();
  } catch (error) {
    return fail(error, "scans.delete");
  }
}