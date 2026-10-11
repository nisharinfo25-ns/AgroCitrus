/**
 * Environment access.
 *
 * The `NEXT_PUBLIC_` prefix is the ONLY way a value may reach the browser, and
 * that prefix is applied to the Supabase URL and the anonymous key alone. The
 * service-role key is read through `serverEnv()` which throws if it is ever
 * called from a client bundle.
 */

import "server-only";

/** Thrown when a server-only secret is touched from the browser. */
export class ServerOnlyViolation extends Error {
  constructor(name: string) {
    super(
      `Attempted to read the server-only environment variable ${name} from the browser. ` +
        `Only NEXT_PUBLIC_* values may be exposed to the client.`,
    );
    this.name = "ServerOnlyViolation";
  }
}

export class MissingEnvError extends Error {
  constructor(name: string, hint: string) {
    super(`Missing required environment variable ${name}. ${hint}`);
    this.name = "MissingEnvError";
  }
}

function read(name: string): string | undefined {
  // `process.env` is statically inlined by Next.js, so every key must be
  // spelled out literally rather than looked up dynamically.
  switch (name) {
    case "NEXT_PUBLIC_SUPABASE_URL":
      return process.env.NEXT_PUBLIC_SUPABASE_URL;
    case "NEXT_PUBLIC_SUPABASE_ANON_KEY":
      return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    case "SUPABASE_SERVICE_ROLE_KEY":
      return process.env.SUPABASE_SERVICE_ROLE_KEY;
    case "SUPABASE_URL":
      return process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    case "CITRUSGUARD_PYTHON":
      return process.env.CITRUSGUARD_PYTHON;
    case "CITRUSGUARD_MODEL_CACHE_DIR":
      return process.env.CITRUSGUARD_MODEL_CACHE_DIR;
    case "CITRUSGUARD_DATA_DIR":
      return process.env.CITRUSGUARD_DATA_DIR;
    case "CITRUSGUARD_MODEL_DIR":
      return process.env.CITRUSGUARD_MODEL_DIR;
    case "CITRUSGUARD_REPORT_DIR":
      return process.env.CITRUSGUARD_REPORT_DIR;
    case "CITRUSGUARD_PROJECT_ROOT":
      return process.env.CITRUSGUARD_PROJECT_ROOT;
    default:
      return undefined;
  }
}

/** Value + a readiness flag, for status endpoints that must not throw. */
export function envStatus(name: string): { name: string; configured: boolean } {
  return { name, configured: Boolean(read(name)?.trim()) };
}

export function serverEnv<T extends string>(name: T): string {
  const value = read(name);
  if (!value?.trim()) {
    throw new MissingEnvError(
      name,
      name === "SUPABASE_SERVICE_ROLE_KEY"
        ? "Set it in your deployment environment. Find it in Supabase Dashboard -> Project Settings -> API Keys. Never expose it to the browser."
        : "Copy .env.example to .env.local and fill in the value.",
    );
  }
  return value.trim();
}

export function serverEnvOr<T extends string>(name: T, fallback: string): string {
  return read(name)?.trim() || fallback;
}

/** Numeric env with a clamped, validated range. */
export function serverEnvNumber(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = read(name as never);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (opts.min !== undefined && parsed < opts.min) return fallback;
  if (opts.max !== undefined && parsed > opts.max) return fallback;
  return parsed;
}

// --------------------------------------------------------------------------
// Public (client-safe) configuration
// --------------------------------------------------------------------------

export const PUBLIC_SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "https://bpmoafdikilbpcxbbmyi.supabase.co";

export const PUBLIC_SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

/** True when the app has enough configuration to talk to Supabase at all. */
export const isSupabaseConfigured = PUBLIC_SUPABASE_URL.length > 0 && PUBLIC_SUPABASE_ANON_KEY.length > 0;

/** Storage bucket names, kept in one place so client and server agree. */
export const BUCKETS = {
  dataset: "citrus-dataset",
  models: "trained-models",
  scans: "scan-images",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

export const APP_CONFIG = {
  maxUploadMb: serverEnvNumber("CITRUSGUARD_MAX_UPLOAD_MB", 10, { min: 1, max: 50 }),
  minConfidence: serverEnvNumber("CITRUSGUARD_MIN_CONFIDENCE", 0.55, { min: 0, max: 1 }),
  python: serverEnvOr("CITRUSGUARD_PYTHON", "python"),
  modelCacheDir: serverEnvOr("CITRUSGUARD_MODEL_CACHE_DIR", ".cache/citrusguard/models"),
} as const;
