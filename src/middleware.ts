import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";

import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL, isSupabaseConfigured } from "@/lib/env";

/**
 * Session refresh + route protection.
 *
 * Supabase auth tokens are short-lived. This middleware revalidates the session
 * against the auth server on every navigation and writes the refreshed cookies
 * back, so Server Components always see a valid session. Route matching is
 * purely for UX: the authoritative check for every protected action happens in
 * the API layer and in Postgres RLS, never here.
 */

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/auth/callback",
  "/auth/confirm",
  "/api/health",
  "/api/auth",
];

const PROTECTED_PREFIXES = ["/dashboard", "/detect", "/scans", "/profile", "/settings", "/admin"];
const ADMIN_PREFIXES = ["/admin"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname) || pathname.startsWith("/_next") || pathname.includes(".")) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  if (!isSupabaseConfigured) {
    // Without Supabase env vars, signed-in pages cannot work. Send the user to
    // login with an actionable message rather than rendering a broken shell.
    if (PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      url.searchParams.set("error", "not_configured");
      return NextResponse.redirect(url);
    }
    return response;
  }

  const supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        // Rebuild the response first: NextResponse cookies are immutable once
        // the response object exists, so setting on the old one is a no-op.
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    } satisfies CookieMethodsServer,
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const needsAuth = PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (!user && needsAuth) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve intent so the user lands where they meant to go.
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  // Admin routes get an extra server-side role probe. Hiding the nav item is
  // cosmetic; this redirect is backed by the RLS-protected profiles read and
  // by the admin check inside every admin API route.
  if (user && ADMIN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profile?.role !== "admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      url.searchParams.set("error", "forbidden");
      return NextResponse.redirect(url);
    }
  }

  // Signed-in users should not see the marketing pages.
  if (user && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. The callback route and
     * health endpoint are public and excluded by `isPublicPath` above.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)",
  ],
};
