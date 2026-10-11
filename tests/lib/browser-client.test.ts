import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression test for the failure that made sign-in look broken while the
 * Supabase key was perfectly valid.
 *
 * The symptom: the token request returned 200, the browser held a session in
 * `localStorage`, and the app still refused to leave /login. The cause was
 * using `createClient` from `@supabase/supabase-js`, which persists the session
 * to `localStorage` only. Every Server Component, route handler and the
 * middleware read *cookies*, saw no session, and redirected back.
 *
 * These tests assert the contract that prevents a regression: the browser
 * client must come from `@supabase/ssr` (so it syncs cookies), and it must
 * never be handed the service-role key.
 */

describe("browser Supabase client", () => {
  afterEach(() => {
    // The client is cached on globalThis for the life of the page, so the
    // cache has to be cleared between tests or the first construction wins.
    delete (globalThis as Record<string, unknown>).__citrusguardSupabaseBrowserClient;
    vi.resetModules();
  });

  it("imports createBrowserClient from @supabase/ssr, not from @supabase/supabase-js", async () => {
    // The distinction is the entire point of the module: @supabase/supabase-js
    // writes the session to localStorage only and never sets a cookie, so the
    // server sees no session and bounces the user back to /login.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/lib/supabase/browser.ts", import.meta.url), "utf8"),
    );

    expect(source).toMatch(/from\s+"@supabase\/ssr"/);
    // A bare `createClient(` call would be the localStorage-only client.
    expect(source).not.toMatch(/\bcreateClient\s*(<[^>]*>)?\s*\(/);
  });

  it("reads only the NEXT_PUBLIC_ variables and never the service-role key", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/lib/supabase/browser.ts", import.meta.url), "utf8"),
    );

    expect(source).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL");
    expect(source).toContain("process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY");
    // The service-role key bypasses RLS. It must never be reachable from a
    // client bundle, not even by accident.
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("does not import server-only or next/headers as code", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/lib/supabase/browser.ts", import.meta.url), "utf8"),
    );

    // Comments legitimately name these modules when explaining why they are
    // absent, so only real import statements are inspected.
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");

    expect(code).not.toMatch(/import\s+"server-only"/);
    expect(code).not.toMatch(/from\s+"next\/headers"/);
    expect(code).not.toMatch(/require\(\s*["']next\/headers["']\s*\)/);
  });

  it("implements cookie getAll/setAll so the session reaches the server", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/lib/supabase/browser.ts", import.meta.url), "utf8"),
    );

    expect(source).toMatch(/getAll\s*\(/);
    expect(source).toMatch(/setAll\s*\(/);
    // The old failure mode: a localStorage-only client.
    expect(source).not.toMatch(/storage:\s*window\.localStorage/);
  });
});
