import { describe, expect, it } from "vitest";

import { describeDbError, isMissingSchemaError } from "@/lib/db/schema";

/**
 * The distinction these tests protect is the whole point of the module:
 *
 *   "the table is not there"  -> a setup state with an honest empty state
 *   "the query was wrong"     -> a real fault that must stay visible
 *
 * Getting it backwards in either direction is a real defect. Too narrow and a
 * signed-in user gets a 500 with a stack digest instead of "No scans yet"; too
 * broad and a permissions or join failure is silently reported as "no data",
 * which reads as data loss.
 */

const asError = (shape: Record<string, unknown>) => shape;

describe("isMissingSchemaError", () => {
  it("recognises the PostgREST message for an absent table", () => {
    // This is the exact text Supabase returns for an unmigrated project.
    expect(
      isMissingSchemaError(
        asError({
          code: "PGRST205",
          message: "Could not find the table 'public.scans' in the schema cache.",
        }),
      ),
    ).toBe(true);
  });

  it("recognises the message even when the code is absent or unknown", () => {
    // A bare PostgREST error, or a driver that omits SQLSTATE, must still match.
    expect(isMissingSchemaError(asError({ message: "relation \"public.scans\" does not exist" }))).toBe(true);
    expect(isMissingSchemaError(asError({ code: "XYZ", message: "table does not exist" }))).toBe(true);
    expect(isMissingSchemaError(asError({ message: "column scans.overlay_path does not exist" }))).toBe(true);
  });

  it("recognises the SQLSTATE codes Postgres uses for a missing relation", () => {
    for (const code of ["42P01", "42703", "42p01", "3F000", "PGRST205", "PGRST200", "PGRST202"]) {
      expect(isMissingSchemaError(asError({ code, message: "irrelevant" })), code).toBe(true);
    }
  });

  it("does not treat an RLS denial as a missing schema", () => {
    // This is the important negative case. `42501` is insufficient_privilege:
    // the table exists, the caller simply may not read it. Reporting it as
    // "schema not applied" would tell an operator to re-run migrations forever.
    expect(isMissingSchemaError(asError({ code: "42501", message: "permission denied for table scans" }))).toBe(
      false,
    );
  });

  it("does not treat a real query fault as a missing schema", () => {
    const faults = [
      { code: "42883", message: "function profiles.role does not exist" },
      { code: "23505", message: "duplicate key value violates unique constraint" },
      { code: "57014", message: "canceling statement due to statement timeout" },
      { code: "08006", message: "connection failure" },
      { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      { message: "" },
      { message: "JWT expired" },
    ];
    for (const fault of faults) {
      expect(isMissingSchemaError(asError(fault)), JSON.stringify(fault)).toBe(false);
    }
  });

  it("tolerates a null, undefined or non-object argument", () => {
    // `error` comes straight off the Supabase client and is `null` on success,
    // so a guard that dereferences it would itself be a crash.
    for (const value of [null, undefined, 0, "", "does not exist", true, []]) {
      expect(isMissingSchemaError(value)).toBe(false);
    }
  });
});

describe("describeDbError", () => {
  it("says the schema is missing and keeps PostgREST's relation name", () => {
    // The relation name is the single most useful clue when standing up a fresh
    // project, so it must survive into the log line.
    const line = describeDbError("list failed", {
      code: "PGRST205",
      message: "Could not find the table 'public.scans' in the schema cache.",
    });
    expect(line).toContain("schema is not applied");
    expect(line).toContain("public.scans");
    expect(line.startsWith("list failed")).toBe(true);
  });

  it("keeps the SQLSTATE for a non-schema error", () => {
    const line = describeDbError("insert failed", {
      code: "42501",
      message: "permission denied for table scans",
    });
    expect(line).toContain("[42501]");
    expect(line).toContain("permission denied");
    expect(line).not.toContain("schema is not applied");
  });

  it("never throws on a missing or unrecognisable error object", () => {
    expect(() => describeDbError("x", null)).not.toThrow();
    expect(() => describeDbError("x", undefined)).not.toThrow();
    expect(typeof describeDbError("x", undefined)).toBe("string");
  });

  it("does not echo an object representation for a non-Error value", () => {
    // `[object Object]` in a log tells nobody anything; the code and message
    // must be what gets reported.
    const line = describeDbError("list failed", { code: "PGRST205", message: "missing" });
    expect(line).not.toContain("[object Object]");
  });
});