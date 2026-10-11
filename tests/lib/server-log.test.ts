import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serverLog } from "@/lib/server";

/**
 * `serverLog` exists so a failure can be diagnosed from the terminal. It was
 * printing the literal string `[object Object]` for every PostgREST error,
 * because those are plain objects rather than `Error` instances - so the log
 * named the failing subsystem but not the cause.
 *
 * These tests pin the two properties that make the log useful and safe:
 * PostgREST detail actually appears, and nothing else does.
 */

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

/** Everything `serverLog` wrote to console.error, joined. */
const logged = () => consoleError.mock.calls.map((call) => call.join(" ")).join("\n");

describe("serverLog", () => {
  it("always prefixes the scope and message", () => {
    serverLog("scans", "list failed");
    expect(logged()).toContain("[citrusguard:scans] list failed");
  });

  it("writes nothing extra when no error is passed", () => {
    serverLog("scans", "list failed");
    expect(logged()).not.toContain("::");
  });

  it("uses the message of a real Error", () => {
    serverLog("scans", "boom", new Error("connection reset"));
    expect(logged()).toContain(":: connection reset");
  });

  it("renders a PostgREST error instead of [object Object]", () => {
    // The failure this exists to fix. PostgREST returns a plain object, so the
    // old `String(error)` produced `[object Object]` and the operator learned
    // nothing beyond "something failed".
    serverLog("scans", "list failed", {
      code: "PGRST205",
      message: "Could not find the table 'public.scans' in the schema cache.",
      details: null,
      hint: "Did you run the migrations?",
    });

    const output = logged();
    expect(output).not.toContain("[object Object]");
    expect(output).toContain("[PGRST205]");
    expect(output).toContain("Could not find the table 'public.scans'");
    expect(output).toContain("Did you run the migrations?");
  });

  it("omits absent and empty fields rather than printing noise", () => {
    // PostgREST sends `details: null` and `hint: ""` for errors that have
    // neither. Printing them as "null" and "" buries the message.
    serverLog("predict", "model lookup failed", {
      code: "42P01",
      message: "relation does not exist",
      details: null,
      hint: "",
    });

    const output = logged();
    expect(output).toContain("[42P01] relation does not exist");
    expect(output).not.toContain("null");
    expect(output.endsWith("null")).toBe(false);
  });

  it("falls back to serialising an object with no known fields", () => {
    // Better a truncated JSON blob than a bare `[object Object]`.
    const output = (() => {
      serverLog("weird", "unexpected", { somethingElse: "value" });
      return logged();
    })();
    expect(output).toContain("somethingElse");
    expect(output).not.toContain("[object Object]");
  });

  it("does not throw on null, undefined, or an unserialisable value", () => {
    // `error` is typed `unknown` and really does arrive as null from the
    // Supabase client on the success path of a mis-wrapped call.
    expect(() => serverLog("x", "m", null)).not.toThrow();
    expect(() => serverLog("x", "m", undefined)).not.toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serverLog("x", "m", cyclic)).not.toThrow();
    expect(logged()).toContain("unserialisable");
  });

  it("never stringifies the whole error object into the log line", () => {
    // A whole-object dump can carry request headers or credentials. Only the
    // four named fields are read, so a value in any other key cannot escape.
    serverLog("scans", "list failed", {
      code: "PGRST205",
      message: "missing table",
      apikey: "super-secret-value-that-must-not-be-logged",
      authorization: "Bearer another-secret",
    });

    const output = logged();
    expect(output).not.toContain("super-secret-value-that-must-not-be-logged");
    expect(output).not.toContain("another-secret");
    expect(output).toContain("missing table");
  });

  it("prints a stack for an Error in development, and not in production", () => {
    // `process.env.NODE_ENV` is typed readonly by Next's ambient types, and it is
    // only the *dev/prod* distinction under test, so it is swapped through a
    // cast rather than by widening the production code's signature.
    const env = process.env as unknown as { NODE_ENV: string };
    const original = env.NODE_ENV;
    try {
      env.NODE_ENV = "development";
      const dev = new Error("dev boom");
      serverLog("scans", "failed", dev);
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes("dev boom"))).toBe(true);

      consoleError.mockClear();
      env.NODE_ENV = "production";
      serverLog("scans", "failed", dev);
      // Only the one summary line: a stack trace in production logs leaks paths
      // and can carry interpolated detail.
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      env.NODE_ENV = original;
    }
  });
});