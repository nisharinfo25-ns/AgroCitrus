/**
 * PATCH /api/profile
 *
 * Updates the caller's own `profiles` row.
 *
 * Only `full_name` is writable, through the RLS-scoped client, so the
 * `profiles_update_own` policy is the authorisation check. Two things are
 * deliberately *not* accepted from the request:
 *
 *   - `role`  - self-promotion to ADMIN. Escalation has to happen out of band.
 *   - `email` - owned by Supabase Auth; writing it here would desync the two.
 *
 * Sending either returns 400 naming the field, rather than silently ignoring
 * it, so a client bug is visible instead of looking like a successful no-op.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, fail, ok, serverLog } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateProfile = z
  .object({
    full_name: z.string().trim().max(120).nullable(),
  })
  .strict();

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const { supabase, user } = await requireUser();

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new AppError("validation_error", "The request body must be JSON.");
    }

    // `strict()` rejects unknown keys with a Zod issue; translate the two
    // privileged fields into a message that says *why* rather than listing
    // every unexpected property.
    if (isRecord(payload) && ("role" in payload || "email" in payload || "id" in payload)) {
      const blocked = ["id", "email", "role"].filter((field) => field in (payload as object));
      throw new AppError(
        "forbidden",
        `${blocked.join(", ")} cannot be changed from the app. Role changes are made by an administrator.`,
      );
    }

    const parsed = UpdateProfile.safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        "validation_error",
        parsed.error.issues[0]?.message ?? "The profile update was not valid.",
      );
    }

    // No `.eq("id", user.id)` filter is accepted from the caller, and the
    // scoped client cannot bypass RLS, so this can only ever touch their row.
    const { data, error } = await supabase
      .from("profiles")
      .update({ full_name: parsed.data.full_name, updated_at: new Date().toISOString() })
      .eq("id", user.id)
      .select("id, email, full_name, role, created_at, updated_at")
      .maybeSingle();

    if (error) {
      serverLog("profile", "update failed", error);
      throw new AppError("internal_error", "Your profile could not be saved. Try again in a moment.");
    }

    if (!data) {
      // RLS returning no row means the profile row does not exist (the signup
      // trigger has not fired). Say so rather than reporting a silent success.
      throw new AppError(
        "not_found",
        "No profile row exists for this account yet. Try again shortly, or contact an administrator.",
      );
    }

    return ok({ profile: data });
  } catch (error) {
    return fail(error, "profile");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
