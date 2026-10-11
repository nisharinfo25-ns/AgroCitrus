/**
 * GET /api/auth/callback
 *
 * OAuth / email-link return target. Exchanges the `code` query parameter for a
 * session, sets the cookies, and redirects to `next` (validated as a same-origin
 * relative path so this endpoint cannot be used as an open redirect).
 */

import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured, PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from "@/lib/env";
import { serverLog } from "@/lib/server";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only same-origin, path-relative destinations are accepted. */
function safeRedirect(target: string | null, fallback = "/dashboard"): string {
  if (!target) return fallback;
  // Reject absolute URLs, protocol-relative URLs and backslash tricks.
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return fallback;
  return target;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeRedirect(searchParams.get("next"));
  const errorDescription = searchParams.get("error_description");

  if (errorDescription) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", errorDescription);
    return NextResponse.redirect(url);
  }

  if (!isSupabaseConfigured) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", "not_configured");
    return NextResponse.redirect(url);
  }

  if (!code) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", "missing_code");
    return NextResponse.redirect(url);
  }

  let response = NextResponse.redirect(`${origin}${next}`);

  const supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        // The response object must be rebuilt before the cookies are attached:
        // NextResponse cookies are immutable once the response is created.
        response = NextResponse.redirect(`${origin}${next}`);
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    } satisfies CookieMethodsServer,
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    serverLog("auth", `callback exchange failed: ${error.message}`);
    const url = new URL("/login", origin);
    url.searchParams.set("error", "invalid_code");
    return NextResponse.redirect(url);
  }

  return response;
}