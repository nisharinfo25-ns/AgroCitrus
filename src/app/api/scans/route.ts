/**
 * GET /api/scans  - the caller's scan history, filtered and paginated.
 *
 * Every read is executed with the RLS-scoped client, so `user_id` is filtered by
 * Postgres rather than by a query parameter the caller controls. The `userId`
 * argument exists only so the query can be explicit in logs and so the
 * authorization intent is visible at the call site.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { listScans, signScanImages } from "@/lib/db/scans";
import { getDashboardStats } from "@/lib/db/stats";
import { createAdminClient } from "@/lib/supabase/client";
import { enforceRateLimit, fail, ok } from "@/lib/server";
import type { Paginated, ScanWithUrls } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(12),
  search: z.string().max(120).optional(),
  status: z.enum(["healthy", "diseased", "all"]).default("all"),
  input_type: z.enum(["leaf", "fruit", "all"]).default("all"),
  low_confidence: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  sort: z.enum(["newest", "oldest", "confidence"]).default("newest"),
});

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    enforceRateLimit(request, user.id, { limit: 120, windowMs: 60_000, scope: "scan list" });

    const params = request.nextUrl.searchParams;
    const query = QuerySchema.parse({
      page: params.get("page") ?? undefined,
      page_size: params.get("page_size") ?? undefined,
      search: params.get("search") ?? undefined,
      status: params.get("status") ?? undefined,
      input_type: params.get("input_type") ?? undefined,
      low_confidence: params.get("low_confidence") ?? undefined,
      sort: params.get("sort") ?? undefined,
    });

    const result = await listScans(supabase, {
      page: query.page,
      pageSize: query.page_size,
      search: query.search,
      status: query.status,
      inputType: query.input_type,
      lowConfidence: query.low_confidence,
      sort: query.sort,
    });

    // Signed URLs are minted only for rows RLS already authorised.
    const admin = createAdminClient();
    const data: ScanWithUrls[] = await Promise.all(
      result.scans.map(async (scan) => ({
        ...scan,
        ...(await signScanImages(admin, scan)),
      })),
    );

    const body: Paginated<ScanWithUrls> = {
      data,
      pagination: {
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
        total_pages: result.totalPages,
      },
    };

    return ok(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fail(error, "scans.list");
  }
}