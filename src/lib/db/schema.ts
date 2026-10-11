/**
 * Telling "the table is not there" apart from "the query failed".
 *
 * Postgres surfaces an unmigrated database through PostgREST as a 404 with a
 * message like `Could not find the table 'public.scans' in the schema cache.`
 * and a SQLSTATE of `42P01` (undefined_table) or `42703` (undefined_column).
 * Every other error - a failed join, a bad filter, a timeout, a permissions
 * problem - is a real fault and must stay visible.
 *
 * The distinction matters because the first group is a deployment state with an
 * honest empty-state answer ("Model is not configured", "No scans yet"), while
 * the second group is an error the operator has to see. Collapsing the two makes
 * either a silent data-loss bug or a 500 page for a merely unconfigured install.
 *
 * No secret ever passes through here: only the code and the message text, and
 * only the boolean comes back out.
 */

const MISSING_SCHEMA_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42P07", // duplicate_table (a re-run of an applied migration)
  "42710", // duplicate_object
  "3F000", // invalid_schema_name
  "PGRST205", // PostgREST: table not found in schema cache
  "PGRST200", // PostgREST: relation not found
  "PGRST202", // PostgREST: column not found
]);

/**
 * Text fallbacks, matched only when the SQLSTATE is unhelpful or absent.
 *
 * Deliberately NOT a bare `does not exist`: Postgres uses that wording for an
 * undefined *function* too (`42883 undefined_function`), and that is a real
 * fault - a dropped column in a query, or a missing RPC - not an unmigrated
 * database. Only relations are listed here.
 */
const MISSING_SCHEMA_TEXT = [
  /could not find the (table|column|relation|schema)/i,
  /in the schema cache/i,
  // `relation "public.scans" does not exist` / `column scans.overlay_path does
  // not exist`. The gap between the noun and the wording is bounded so an
  // unrelated sentence cannot be dragged in by a lazy match.
  /\b(table|column|relation|schema)\b[\s\S]{0,120}?\bdoes not exist\b/i,
  /\bundefined (table|column|schema)\b/i,
];

interface MaybePostgrestError {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

/**
 * True only when the failure means the schema is absent, never when it means the
 * query was wrong.
 */
export function isMissingSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as MaybePostgrestError;
  const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
  if (MISSING_SCHEMA_CODES.has(code)) return true;
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  return MISSING_SCHEMA_TEXT.some((pattern) => pattern.test(text));
}

/**
 * A one-line, secret-free description for server logs. The PostgREST message is
 * reproduced because it names the exact missing relation, which is the single
 * most useful clue when somebody is standing up a fresh project.
 */
export function describeDbError(scope: string, error: unknown): string {
  if (isMissingSchemaError(error)) {
    const e = (error ?? {}) as MaybePostgrestError;
    const msg = typeof e.message === "string" ? e.message : "schema not found";
    return `${scope}: database schema is not applied -> ${msg}`;
  }
  const e = (error ?? {}) as MaybePostgrestError;
  const code = typeof e.code === "string" ? e.code : "";
  const msg = typeof e.message === "string" ? e.message : String(error);
  return `${scope}: ${code ? `[${code}] ` : ""}${msg}`;
}