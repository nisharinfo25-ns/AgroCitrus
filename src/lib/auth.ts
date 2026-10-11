/**
 * Authentication + authorization helpers for route handlers.
 *
 * `requireUser()` returns the RLS-scoped client bound to the caller's cookies,
 * so every query it runs is already filtered by Postgres policies. `requireAdmin()`
 * additionally re-checks the role in the database - the client never trusts a
 * role value taken from the request body, a query parameter or a JWT claim the
 * user could influence.
 */

import "server-only";

import type { User } from "@supabase/supabase-js";

import { forbidden, unauthorized } from "@/lib/errors";
import { createAdminClient, createServerClientScoped } from "@/lib/supabase/client";

export type Role = "admin" | "user";

export interface AuthedUser {
  user: User;
  supabase: Awaited<ReturnType<typeof createServerClientScoped>>;
  profile: Profile;
  role: Role;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  created_at: string;
  updated_at: string;
}

/** Resolve the signed-in user plus profile, or null. */
export async function getCurrentUser(): Promise<AuthedUser | null> {
  const supabase = await createServerClientScoped();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  // RLS allows a user to read exactly one profiles row: their own.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, created_at, updated_at")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile) {
    // A missing profile is possible if the signup trigger has not landed yet.
    // Fall back to a default USER role rather than granting anything.
    return {
      user,
      supabase,
      profile: {
        id: user.id,
        email: user.email ?? "",
        full_name: (user.user_metadata?.full_name as string | undefined) ?? null,
        role: "user" as Role,
        created_at: user.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      role: "user",
    };
  }

  return { user, supabase, profile: profile as Profile, role: (profile.role as Role) ?? "user" };
}

export async function requireUser(): Promise<AuthedUser> {
  const authed = await getCurrentUser();
  if (!authed) throw unauthorized();
  return authed;
}

export async function requireAdmin(): Promise<AuthedUser> {
  const authed = await requireUser();
  if (authed.role !== "admin") {
    throw forbidden("Admin access is required for this operation.");
  }
  return authed;
}

/**
 * Admin check for routes that need the service role. Verifies the caller is an
 * admin using the RLS-scoped client first, then returns an admin client.
 */
export async function requireAdminWithServiceClient() {
  const authed = await requireAdmin();
  return { authed, admin: createAdminClient() };
}
