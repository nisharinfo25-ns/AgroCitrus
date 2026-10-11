/**
 * Human-readable classification of Supabase auth failures.
 *
 * Client-safe on purpose: the auth forms run in the browser and import this, so
 * it must not pull in `server-only` or `next/headers`.
 *
 * Why this exists
 * ---------------
 * Supabase collapses several very different failures into a bare `message` on
 * an `AuthError`. The two that matter most are trivially confused:
 *
 *   "Invalid login credentials" - the email or password is wrong. The user's
 *       problem, and retrying with different details is the fix.
 *   "Invalid API key"          - the project's anon key was rejected before the
 *       credentials were ever examined. No password can succeed, and the user
 *       cannot fix it: it needs a new key in `.env.local`.
 *
 * Shown verbatim, both read as "sign in failed", which sends people to retype a
 * password that was never the problem. This classifies the message so the form
 * can name the actual cause and, for the key case, say what to change.
 *
 * Matching is on lowercased substrings because the exact wording is a Supabase
 * implementation detail that has changed between releases (and differs between
 * the legacy anon JWT and newer publishable keys).
 */

export type AuthErrorKind =
  /** The anon key was rejected. No credential can succeed. Operator fix. */
  | "invalid_api_key"
  /** Supabase could not be reached at all. */
  | "network"
  /** Email/password pair is wrong. The only kind the user can fix by typing. */
  | "invalid_credentials"
  /** Too many attempts. */
  | "rate_limited"
  /** Not classified. */
  | "unknown";

export interface AuthErrorDescription {
  kind: AuthErrorKind;
  /** The alert headline. Safe to show to an end user. */
  message: string;
  /**
   * Extra line with the concrete next step, or `null` when `message` already
   * says everything there is to say. Kept separate so the form can render it in
   * a quieter style than the headline.
   */
  hint: string | null;
}

const API_KEY_HINT =
  "The project's public key was rejected before your email or password was even checked, " +
  "so no account can sign in until it is replaced. Set NEXT_PUBLIC_SUPABASE_ANON_KEY in " +
  ".env.local to the current anon (or publishable) key from Supabase -> Project Settings -> " +
  "API Keys, then restart the server: NEXT_PUBLIC_* values are inlined at build time, so " +
  "editing .env.local alone has no effect.";

const NETWORK_HINT =
  "Check that the device is online and that NEXT_PUBLIC_SUPABASE_URL in .env.local points at " +
  "the right project.";

/** Pull a comparable message out of whatever `supabase-js` (or a throw) gave us. */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

export function describeAuthError(error: unknown): AuthErrorDescription {
  const raw = messageOf(error);
  const text = raw.toLowerCase();

  // Checked first: when the key is bad, every endpoint 401s, so credential
  // errors can be shadowed by a key error and vice versa. The key is the more
  // fundamental problem, so it wins.
  if (text.includes("api key") || text.includes("apikey")) {
    return {
      kind: "invalid_api_key",
      message: raw || "Supabase rejected the API key.",
      hint: API_KEY_HINT,
    };
  }

  if (
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("network error") ||
    text.includes("fetch failed") ||
    text.includes("load failed")
  ) {
    return {
      kind: "network",
      message: "Could not reach Supabase.",
      hint: NETWORK_HINT,
    };
  }

  if (text.includes("rate limit") || text.includes("too many") || text.includes("security purposes")) {
    return {
      kind: "rate_limited",
      message: raw || "Too many attempts. Please wait a moment and try again.",
      hint: null,
    };
  }

  if (text.includes("invalid login credentials")) {
    // Already written to be user-facing; no hint needed.
    return { kind: "invalid_credentials", message: raw, hint: null };
  }

  return {
    kind: "unknown",
    message: raw || "Sign in failed. Please try again.",
    hint: null,
  };
}
