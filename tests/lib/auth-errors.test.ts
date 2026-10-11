import { describe, expect, it } from "vitest";

import { describeAuthError } from "@/lib/supabase/auth-errors";

/**
 * The classifier exists because a rejected project key and a wrong password
 * both arrive as terse `message` strings. These tests pin the distinction: if
 * the key case ever regresses into `invalid_credentials` (or falls through to
 * `unknown`, losing the hint), the user is told to retype a password that was
 * never the problem.
 */

const keyError = { message: "Invalid API key" };

describe("describeAuthError", () => {
  describe("rejected project key", () => {
    it("classifies a bare 'Invalid API key' as an operator problem, not a credential problem", () => {
      const result = describeAuthError(keyError);
      expect(result.kind).toBe("invalid_api_key");
      expect(result.message).toBe("Invalid API key");
    });

    it("attaches a hint naming the variable to change and the restart requirement", () => {
      const { hint } = describeAuthError(keyError);
      expect(hint).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
      expect(hint).toContain(".env.local");
      // Inlined at build time, so editing the file alone does nothing.
      expect(hint).toMatch(/restart/i);
    });

    it("matches regardless of casing", () => {
      expect(describeAuthError({ message: "invalid api key" }).kind).toBe("invalid_api_key");
      expect(describeAuthError({ message: "INVALID API KEY" }).kind).toBe("invalid_api_key");
    });

    it("matches the publishable-key spelling without the space", () => {
      expect(describeAuthError({ message: "Invalid apikey" }).kind).toBe("invalid_api_key");
    });

    it("takes precedence over a credential-shaped message, since the key fails first", () => {
      // A bad key can surface as a credential error on some endpoints; the key
      // is the more fundamental fault and must win.
      const result = describeAuthError({ message: "Invalid login credentials" });
      expect(result.kind).toBe("invalid_credentials");

      const shadowed = describeAuthError({ message: "Invalid API key" });
      expect(shadowed.kind).not.toBe("invalid_credentials");
    });
  });

  describe("wrong credentials", () => {
    it("passes the message through and adds no hint", () => {
      const result = describeAuthError({ message: "Invalid login credentials" });
      expect(result.kind).toBe("invalid_credentials");
      expect(result.message).toBe("Invalid login credentials");
      // The message is already user-facing; a hint would be noise.
      expect(result.hint).toBeNull();
    });
  });

  describe("network failures", () => {
    it.each([
      "Failed to fetch",
      "NetworkError when attempting to fetch resource",
      "fetch failed",
    ])("classifies %j as a network problem", (message) => {
      const result = describeAuthError({ message });
      expect(result.kind).toBe("network");
      expect(result.hint).toContain("NEXT_PUBLIC_SUPABASE_URL");
    });
  });

  describe("rate limiting", () => {
    it("classifies a rate-limit message", () => {
      expect(describeAuthError({ message: "Too many requests" }).kind).toBe("rate_limited");
    });
  });

  describe("unclassified input", () => {
    it("passes an unknown message through rather than swallowing it", () => {
      const result = describeAuthError({ message: "Something unexpected happened" });
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe("Something unexpected happened");
      expect(result.hint).toBeNull();
    });

    it.each([
      ["an empty Error", new Error("")],
      ["a bare string", "Something broke"],
      ["null", null],
      ["undefined", undefined],
      ["a number", 42],
      ["an object with no message", { status: 500 }],
    ])("always produces a non-empty message for %s", (_label, input) => {
      const result = describeAuthError(input);
      expect(result.message.length).toBeGreaterThan(0);
    });

    it("does not throw on a non-object without a message property", () => {
      expect(() => describeAuthError(Object.create(null))).not.toThrow();
    });
  });
});
