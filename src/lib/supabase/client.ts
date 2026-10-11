/**
 * Server-side Supabase clients.
 *
 * Two distinct clients, two distinct privilege levels:
 *
 *   server - anon key + the caller's cookies. Enforces RLS, so a route can
 *            never accidentally read another user's rows.
 *   admin  - SERVICE ROLE key. Bypasses RLS. Only for operations that are
 *            already authorized (admin actions, dataset/model sync) and
 *            never for serving a user request's data.
 *
 * The browser client lives in `./browser` and is imported by client components,
 * so this module stays `server-only` and must never be reached from `"use client"`.
 * The service role key is only ever referenced through `createAdminClient()`.
 */

import "server-only";

import { cookies, headers } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL, serverEnv } from "@/lib/env";

export type { Database } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/browser";

// --------------------------------------------------------------------------
// Server (RLS-enforced, request-scoped)
// --------------------------------------------------------------------------
export async function createServerClientScoped() {
  const cookieStore = await cookies();
  const headerStore = await headers();

  return createServerClient<Database>(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot mutate cookies. Middleware refreshes the
          // session instead, so this is expected and safe to swallow.
        }
      },
    },
    global: {
      headers: { "x-requested-with": headerStore.get("x-requested-with") ?? "" },
    },
  });
}

// --------------------------------------------------------------------------
// Admin (service role, RLS bypassed) - server only
// --------------------------------------------------------------------------
export function createAdminClient(): SupabaseClient<Database> {
  const key = serverEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient<Database>(PUBLIC_SUPABASE_URL, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/** True when a service-role key is configured. Never exposes the value. */
export function isAdminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
