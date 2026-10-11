/**
 * GET /api/admin/stats
 *
 * Admin-only system dashboard. Delegates to `getAdminStats`, which the admin
 * dashboard page also calls, so the JSON API and the on-screen numbers can
 * never disagree.
 *
 * Returns 200 with the full payload; a failure surfaces through the standard
 * error envelope with the right status.
 */

import { requireAdmin } from "@/lib/auth";
import { getAdminStats, type AdminStats } from "@/lib/db/admin-stats";
import { fail, ok } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type { AdminStats };

export async function GET() {
  try {
    const { supabase } = await requireAdmin();
    const stats = await getAdminStats(supabase);
    return ok(stats, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fail(error, "admin.stats");
  }
}
