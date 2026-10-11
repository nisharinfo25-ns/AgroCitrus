/**
 * Promote an EXISTING signed-up user to the ADMIN role.
 *
 * Why a separate script rather than an app feature:
 *
 *   - There is deliberately no "become admin" endpoint. Role changes are
 *     deployment-time operations and need the service-role key, which is
 *     server-only and never reaches the browser.
 *   - No password is ever hardcoded, printed or accepted here. The user must
 *     already exist, created by signing up through the UI. This script only
 *     flips `profiles.role` for an existing account.
 *   - If the profile row is missing it reports that the schema has not been
 *     applied yet, instead of silently creating a row that the
 *     `handle_new_user()` trigger would have created differently.
 *
 * Run it with Node's built-in TypeScript stripping - no extra dependency:
 *
 *     node --experimental-strip-types scripts/bootstrap-admin.ts
 *     node --experimental-strip-types scripts/bootstrap-admin.ts --email a@b.c
 *
 * or via the npm alias:  npm run admin:bootstrap
 *
 * Secrets are never printed. Only variable NAMES, lengths and the user id are.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type EnvFile = Record<string, string>;

const PROJECT_ROOT = process.cwd();

/** Next.js resolution order for local env files. `.env.local` wins. */
const ENV_FILES = [".env.local", ".env"];

/** Postgres enum values, mirrored from `supabase/migrations/0001_schema.sql`. */
const VALID_ROLES = ["admin", "user"] as const;
type Role = (typeof VALID_ROLES)[number];

function loadEnvFile(name: string): EnvFile {
  const path = resolve(PROJECT_ROOT, name);
  const out: EnvFile = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out; // Absent file is normal, not an error.
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching quotes; env files are not JSON.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnv(): EnvFile {
  const merged: EnvFile = {};
  for (const file of ENV_FILES) Object.assign(merged, loadEnvFile(file));
  // Real environment variables win, which is how this runs on a host where the
  // values are injected rather than written to disk.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function fail(message: string, hint?: string): never {
  console.error(`\n  ERROR  ${message}`);
  if (hint) console.error(`\n  ${hint}\n`);
  process.exit(1);
}

/**
 * Report whether a secret is present, using only its length.
 *
 * A fingerprint (first 6 chars) would be enough to tell two keys apart but is
 * still a fragment of a credential, so it is not printed.
 */
function secretState(label: string, value: string | undefined, expectedHint: string): string {
  if (!value || value.trim() === "") {
    return `  ${label.padEnd(26)} NOT SET  -> ${expectedHint}`;
  }
  return `  ${label.padEnd(26)} present (${value.trim().length} chars, value not shown)`;
}

interface AdminUser {
  id: string;
  email: string | null;
}

/** Minimal Admin API call. Returns the parsed body or throws with the status. */
async function adminApi(
  baseUrl: string,
  serviceKey: string,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    /* Non-JSON error page; keep the raw text for the message below. */
  }
  return { status: response.status, body };
}

function messageOf(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["msg", "message", "error_description", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  if (typeof body === "string" && body !== "") return body.slice(0, 300);
  return "(no message)";
}

function parseArgs(argv: string[]): { email: string | null; role: Role; dryRun: boolean; list: boolean } {
  const result = { email: null as string | null, role: "admin" as Role, dryRun: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--email" || arg === "-e") {
      const next = argv[i + 1];
      if (!next) fail("--email needs a value.");
      result.email = next;
      i += 1;
    } else if (arg === "--role" || arg === "-r") {
      const next = argv[i + 1];
      if (!next || !VALID_ROLES.includes(next as Role)) {
        fail(`--role must be one of: ${VALID_ROLES.join(", ")}.`);
      }
      result.role = next as Role;
      i += 1;
    } else if (arg === "--list" || arg === "-l") {
      result.list = true;
    } else if (arg === "--dry-run" || arg === "-n") {
      result.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node --experimental-strip-types scripts/bootstrap-admin.ts [options]",
          "",
          "  -e, --email <address>   Account to promote (default: CITRUSGUARD_ADMIN_EMAIL)",
          "  -r, --role <role>        admin | user            (default: admin)",
          "  -l, --list               List the project's auth users, then exit",
          "  -n, --dry-run            Report what would change; write nothing",
          "  -h, --help               This message",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`, "Run with --help to see the options.");
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv();

  const baseUrl = (env["NEXT_PUBLIC_SUPABASE_URL"] ?? "").trim();
  const serviceKey = (env["SUPABASE_SERVICE_ROLE_KEY"] ?? "").trim();

  console.log("\n  CitrusGuard - admin bootstrap\n");
  console.log(secretState("SUPABASE_URL", baseUrl || env["NEXT_PUBLIC_SUPABASE_URL"], "required"));
  console.log(
    secretState("SERVICE_ROLE_KEY", serviceKey, "Supabase Dashboard -> Project Settings -> API Keys"),
  );

  if (baseUrl === "") {
    fail("NEXT_PUBLIC_SUPABASE_URL is not set.", "Add it to .env.local and run again.");
  }
  if (serviceKey === "") {
    fail(
      "SUPABASE_SERVICE_ROLE_KEY is not set.",
      [
        "Supabase Dashboard -> Project Settings -> API Keys -> service_role.",
        "Paste it into .env.local as:",
        "",
        "  SUPABASE_SERVICE_ROLE_KEY=<the service_role key>",
        "",
        "It is a server-only secret. Never prefix it with NEXT_PUBLIC_ and never",
        "commit it. Restart the Next.js server afterwards so it is picked up.",
      ].join("\n"),
    );
  }

  if (args.list) {
    const listed = await adminApi(baseUrl, serviceKey, "/auth/v1/admin/users?per_page=200");
    if (listed.status >= 400) {
      fail(`Could not list users (HTTP ${listed.status}).`, messageOf(listed.body));
    }
    const users = ((listed.body as { users?: AdminUser[] })?.users ?? []) as AdminUser[];
    console.log(`\n  ${users.length} user(s) in auth.users:\n`);
    for (const user of users) console.log(`    ${user.id}  ${user.email ?? "(no email)"}`);
    console.log("");
    return;
  }

  const email = (args.email ?? env["CITRUSGUARD_ADMIN_EMAIL"] ?? "").trim().toLowerCase();
  if (email === "") {
    fail(
      "No account to promote.",
      [
        "Set CITRUSGUARD_ADMIN_EMAIL in .env.local, or pass one explicitly:",
        "",
        "  node --experimental-strip-types scripts/bootstrap-admin.ts --email you@example.com",
        "",
        "The account must already exist - sign up through the UI first.",
      ].join("\n"),
    );
  }

  // ---- 1. find the existing auth user -------------------------------- //
  // The Admin API lists users and filters server-side; there is no
  // "get user by email" endpoint, so the list is filtered here. The comparison
  // is on the normalised address, matching how Supabase stores it.
  const listed = await adminApi(baseUrl, serviceKey, "/auth/v1/admin/users?per_page=200");
  if (listed.status >= 400) {
    fail(`Could not read auth.users (HTTP ${listed.status}).`, messageOf(listed.body));
  }
  const users = ((listed.body as { users?: AdminUser[] })?.users ?? []) as AdminUser[];
  const match = users.find((user) => (user.email ?? "").toLowerCase() === email);

  if (!match) {
    fail(
      `No auth user found for ${email}.`,
      [
        `${users.length} user(s) exist. Run with --list to see them.`,
        "Sign up through the UI first - this script never creates accounts.",
      ].join("\n"),
    );
  }
  console.log(`\n  Found auth user ${match.id} for ${match.email ?? email}`);

  // ---- 2. read the current profile ----------------------------------- //
  const profilesPath = `/rest/v1/profiles?id=eq.${encodeURIComponent(match.id)}&select=id,email,role`;
  const read = await adminApi(baseUrl, serviceKey, profilesPath);
  if (read.status === 404) {
    fail(
      "The profiles table does not exist yet.",
      [
        "Apply the schema first, in the Supabase Dashboard -> SQL Editor:",
        "",
        "  supabase/combined_migration.sql",
        "",
        "That file contains all three migrations concatenated. Run it once - it is",
        "not idempotent. Then re-run this script.",
      ].join("\n"),
    );
  }
  if (read.status >= 400) {
    fail(`Could not read the profile (HTTP ${read.status}).`, messageOf(read.body));
  }

  const rows = (Array.isArray(read.body) ? read.body : []) as Array<{
    id: string;
    email: string | null;
    role: string | null;
  }>;
  const profile = rows[0];

  if (!profile) {
    fail(
      "No profiles row for that account.",
      [
        `auth.users has ${match.id} but public.profiles has no matching row.`,
        "The handle_new_user() trigger creates it on signup; if the trigger is",
        "missing, re-apply supabase/migrations/0002_seed_and_rpcs.sql or create the",
        "row manually with role 'user', then re-run this script.",
      ].join("\n"),
    );
  }

  console.log(`  Current role: ${profile.role ?? "(null)"}  ->  target role: ${args.role}`);

  if (profile.role === args.role) {
    console.log(`\n  Already ${args.role}. Nothing to do.\n`);
    return;
  }

  if (args.dryRun) {
    console.log(`\n  Dry run: would UPDATE public.profiles SET role='${args.role}' WHERE id='${match.id}'.`);
    console.log("  Nothing was written.\n");
    return;
  }

  // ---- 3. write the new role ------------------------------------------ //
  const write = await adminApi(baseUrl, serviceKey, `/rest/v1/profiles?id=eq.${encodeURIComponent(match.id)}`, {
    method: "PATCH",
    body: { role: args.role, updated_at: new Date().toISOString() },
  });
  if (write.status >= 400) {
    fail(`Could not update the profile (HTTP ${write.status}).`, messageOf(write.body));
  }

  console.log(`\n  OK  ${match.email ?? email} is now ${args.role}.`);
  console.log("  Sign out and back in: the role is read from the database on each request.");
  console.log("");
}

await main();