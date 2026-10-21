/**
 * Browser Supabase client.
 *
 * Deliberately separate from `./client`, which is `import "server-only"`. Six
 * client components (the auth forms, the app shell, the sign-out button) need
 * a Supabase client to sign in and out, and importing the server module from
 * them fails the build: `next/headers` and the service-role key have no meaning
 * in the browser bundle.
 *
 * `process.env.NEXT_PUBLIC_*` is inlined at build time by Next.js and reaches
 * the browser by design - that is what the `NEXT_PUBLIC_` prefix means. Only
 * non-secret values are read here. The anon key is safe to expose: it is
 * designed to be public and every query it makes is constrained by RLS.
 *
 * Cookie sync is the whole point of using `@supabase/ssr` here rather than
 * `createClient` from `@supabase/supabase-js`:
 *
 *   - `@supabase/supabase-js` persists the session to `localStorage` ONLY. A
 *     sign-in then appears to succeed in the browser, but Server Components,
 *     route handlers and the middleware all read cookies, see no session, and
 *     bounce the user straight back to /login. The token request returns 200
 *     and the app still appears to do nothing.
 *   - `@supabase/ssr`'s `createBrowserClient` writes the session cookies that
 *     `createServerClient` and the middleware read back, so server and browser
 *     agree on who is signed in.
 *
 * `createBrowserClient` is imported from `@supabase/ssr`, not from
 * `next/headers`, so it is safe in a client component.
 *
 * The singleton is cached on `globalThis` rather than in a module-level `let`.
 * Fast Refresh re-evaluates modules in development; a module-level cache would
 * hand out a second client on every edit, each with its own in-memory session
 * and token-refresh timer, and the last one to refresh would win.
 */

import { createBrowserClient as createSsrBrowserClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Database = any; // generated types would be produced by `supabase gen types`

/** Inlined at build time. Safe to expose: these are the public project settings. */
const DEFAULT_SUPABASE_URL = "https://eczfukabevxcpdbolowm.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjemZ1a2FiZXZ4Y3BkYm9sb3dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MTExMjcsImV4cCI6MjEwODA4NzEyN30.Nq9kS4PAiqodcEVHjLkEY4y58yTSmIIujwN6Rt9fM2U";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL).trim();
const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || DEFAULT_SUPABASE_ANON_KEY).trim();

type ClientGlobal = typeof globalThis & {
  __citrusguardSupabaseBrowserClient?: SupabaseClient<Database>;
};

export function createBrowserClient(): SupabaseClient<Database> {
  if (typeof window === "undefined") {
    throw new Error("createBrowserClient() was called on the server.");
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  const globalRef = globalThis as ClientGlobal;
  if (!globalRef.__citrusguardSupabaseBrowserClient) {
    globalRef.__citrusguardSupabaseBrowserClient = createSsrBrowserClient<Database>(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        cookies: {
          // Read and write the cookies `createServerClient` and the middleware
          // use, so a session established in the browser is visible to Server
          // Components on the very next request.
          getAll() {
            return document.cookie
              .split("; ")
              .filter((entry) => entry.length > 0)
              .map((entry) => {
                const index = entry.indexOf("=");
                const name = index === -1 ? entry : entry.slice(0, index);
                const value = index === -1 ? "" : entry.slice(index + 1);
                return { name, value: decodeURIComponent(value) };
              });
          },
          setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
            cookiesToSet.forEach(({ name, value, options }) => {
              // `document.cookie` cannot set HttpOnly, Secure or SameSite=None
              // via attributes, and Supabase's defaults are already correct for
              // a same-origin app, so the value is appended in the shape the
              // browser accepts. The server client remains the authority for
              // the canonical attributes.
              const encoded = encodeURIComponent(value);
              const secure = options?.secure && location.protocol === "https:" ? "; Secure" : "";
              const sameSite = options?.sameSite === "none" ? "; SameSite=None" : "; SameSite=Lax";
              document.cookie = `${name}=${encoded}; Path=${options?.path ?? "/"}${sameSite}${secure}`;
            });
          },
        },
      },
    );
  }
  return globalRef.__citrusguardSupabaseBrowserClient;
}
