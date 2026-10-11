/**
 * GET /api/admin/users - the user list for the admin dashboard.
 *
 * Read with the RLS-scoped client: `profiles_select_admin` allows an admin to
 * read any profile and nothing else, so this returns exactly the rows an admin
 * may see and cannot be widened by a query parameter.
 */

import { requireAdmin } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { fail, ok } from "@/lib/server";
import type { Profile } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase } = await requireAdmin();

    const [profiles, scanCounts] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, email, full_name, role, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(500),
      // `scans_select_admin` makes this visible to admins only.
      supabase.from("scans").select("user_id").limit(20_000),
    ]);

    if (profiles.error) {
      throw new AppError("internal_error", "The user list could not be loaded.", {
        detail: profiles.error.message,
      });
    }

    const counts = new Map<string, number>();
    for (const row of (scanCounts.data ?? []) as Array<{ user_id: string }>) {
      counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
    }

    const users = ((profiles.data ?? []) as Profile[]).map((profile) => ({
      ...profile,
      scan_count: counts.get(profile.id) ?? 0,
    }));

    return ok({ users, total: users.length }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fail(error, "admin.users.list");
  }
}