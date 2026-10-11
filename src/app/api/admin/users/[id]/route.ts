/**
 * PATCH  /api/admin/users/[id] - change a user's role
 * DELETE /api/admin/users/[id] - remove a user and all their scans
 *
 * Moderation actions. Both are deliberately awkward to perform by accident:
 *
 *   - the last remaining admin cannot demote themselves, because that would
 *     lock everyone out of the admin dashboard permanently;
 *   - the target cannot change their own role, so an admin cannot accidentally
 *     or maliciously strip their own access mid-session;
 *   - a user is only demoted to `user`, never deleted, unless the delete
 *     endpoint is called explicitly.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth";
import { deleteScanFiles } from "@/lib/db/scans";
import { AppError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/client";
import { assertSameOrigin, fail, noContent, ok, serverLog } from "@/lib/server";
import { isUuid } from "@/lib/db/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const RoleSchema = z.object({
  role: z.enum(["admin", "user"]),
});

export async function PATCH(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    if (!isUuid(id)) {
      throw new AppError("not_found", "That user does not exist.");
    }

    const { user, supabase } = await requireAdmin();
    const { role } = RoleSchema.parse(await request.json());

    if (id === user.id) {
      throw new AppError("forbidden", "You cannot change your own role.");
    }

    const { data: target, error: readError } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();

    if (readError || !target) {
      throw new AppError("not_found", "That user does not exist.");
    }

    // Guard the last-admin invariant before demoting anyone.
    if (target.role === "admin" && role === "user") {
      const { count } = await supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "admin");
      if ((count ?? 0) <= 1) {
        throw new AppError(
          "forbidden",
          "This is the only admin account. Promote another user to admin before changing this one.",
        );
      }
    }

    const { data, error } = await supabase
      .from("profiles")
      .update({ role })
      .eq("id", id)
      .select("id, role")
      .single();

    if (error) {
      throw new AppError("internal_error", "The role could not be changed.", { detail: error.message });
    }

    return ok({ profile: data });
  } catch (error) {
    return fail(error, "admin.users.role");
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    if (!isUuid(id)) {
      throw new AppError("not_found", "That user does not exist.");
    }

    const { user, supabase } = await requireAdmin();
    if (id === user.id) {
      throw new AppError("forbidden", "You cannot delete your own account from the admin panel.");
    }

    const { data: target } = await supabase.from("profiles").select("id, role").eq("id", id).maybeSingle();
    if (!target) {
      throw new AppError("not_found", "That user does not exist.");
    }

    if (target.role === "admin") {
      const { count } = await supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "admin");
      if ((count ?? 0) <= 1) {
        throw new AppError("forbidden", "This is the only admin account and cannot be deleted.");
      }
    }

    const admin = createAdminClient();

    // Remove stored artefacts first. If this fails the account is still
    // deleted below - leaving images behind is worse than an orphaned object,
    // and the error is logged rather than surfaced as a partial failure.
    const { data: scans } = await supabase.from("scans").select("id").eq("user_id", id).limit(5000);
    for (const scan of (scans ?? []) as Array<{ id: string }>) {
      await deleteScanFiles(admin, id, scan.id).catch((error) =>
        serverLog("admin.users.delete", `artefact cleanup failed for ${scan.id}`, error),
      );
    }

    // Deleting the auth user cascades to profiles and scans (FK ON DELETE
    // CASCADE), so this is the single authoritative delete.
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) {
      throw new AppError("internal_error", "The user could not be deleted.", { detail: error.message });
    }

    return noContent();
  } catch (error) {
    return fail(error, "admin.users.delete");
  }
}