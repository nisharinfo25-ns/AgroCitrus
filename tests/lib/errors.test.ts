import { describe, expect, it } from "vitest";

import {
  AppError,
  forbidden,
  imageInvalid,
  modelNotConfigured,
  notFound,
  rateLimited,
  safeMessage,
  statusForCode,
  unauthorized,
  validationError,
  type ErrorCode,
} from "@/lib/errors";

describe("AppError", () => {
  it("derives its HTTP status from its code", () => {
    expect(new AppError("unauthorized", "nope").status).toBe(401);
    expect(new AppError("forbidden", "nope").status).toBe(403);
    expect(new AppError("not_found", "nope").status).toBe(404);
    expect(new AppError("validation_error", "nope").status).toBe(400);
    expect(new AppError("rate_limited", "nope").status).toBe(429);
    expect(new AppError("model_not_configured", "nope").status).toBe(503);
    expect(new AppError("internal_error", "nope").status).toBe(500);
  });

  it("never leaks `detail` into the response body", () => {
    // `detail` exists so a server log can carry the real cause. Serialising it
    // would leak file paths, SQL or Python tracebacks to the browser.
    const error = new AppError("internal_error", "Something failed.", {
      detail: "/srv/app/models/part_leaf.keras is corrupt",
    });
    const body = JSON.stringify(error.toJSON());

    expect(body).not.toContain("part_leaf.keras");
    expect(body).not.toContain("corrupt");
    expect(body).toContain("Something failed.");
    expect(JSON.parse(body)).toEqual({
      error: { code: "internal_error", message: "Something failed." },
    });
  });

  it("merges `extra` into the body, since it is declared caller-safe", () => {
    const error = validationError("Bad input.", { fields: [{ path: "image", message: "required" }] });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      error: {
        code: "validation_error",
        message: "Bad input.",
        fields: [{ path: "image", message: "required" }],
      },
    });
  });

  it("keeps `detail` reachable for server-side logging", () => {
    expect(imageInvalid("Bad image.", "magic bytes were 0x00").detail).toBe("magic bytes were 0x00");
  });

  it("is a real Error, so `instanceof` survives", () => {
    expect(new AppError("internal_error", "x")).toBeInstanceOf(Error);
  });
});

describe("error helpers", () => {
  it("uses the documented codes", () => {
    expect(unauthorized().code).toBe("unauthorized");
    expect(forbidden().code).toBe("forbidden");
    expect(notFound().code).toBe("not_found");
    expect(rateLimited().code).toBe("rate_limited");
    expect(modelNotConfigured().code).toBe("model_not_configured");
  });

  it("supplies readable default messages", () => {
    expect(unauthorized().message).toMatch(/signed in/i);
    expect(forbidden().message).toMatch(/permission/i);
    expect(notFound().message).toMatch(/not found/i);
    expect(modelNotConfigured().message).toMatch(/not configured/i);
  });
});

describe("statusForCode", () => {
  it("maps every code to a real HTTP status", () => {
    const codes: ErrorCode[] = [
      "unauthorized",
      "forbidden",
      "not_found",
      "validation_error",
      "image_invalid",
      "image_quality_insufficient",
      "routing_uncertain",
      "model_not_configured",
      "dataset_setup_required",
      "dataset_download_failed",
      "dataset_validation_failed",
      "prediction_failed",
      "storage_error",
      "rate_limited",
      "config_error",
      "internal_error",
    ];
    for (const code of codes) {
      const status = statusForCode(code);
      expect(status, `${code} must map to a status`).toBeGreaterThanOrEqual(400);
      expect(status, `${code} must not map to a redirect`).toBeLessThan(600);
    }
  });

  it("keeps 5xx codes retryable and 4xx codes client-caused", () => {
    // A missing deployment (model not configured) is a 503 so a caller can
    // distinguish "try again later" from "your request was wrong".
    expect(statusForCode("model_not_configured")).toBe(503);
    expect(statusForCode("dataset_setup_required")).toBe(409);
    expect(statusForCode("image_quality_insufficient")).toBe(422);
    // A stage-1 abstention is a refusal, not a server fault: the request was
    // fine, the pipeline chose not to guess a disease head.
    expect(statusForCode("routing_uncertain")).toBe(422);
  });
});

describe("safeMessage", () => {
  it("passes an AppError message through - it is written to be shown", () => {
    expect(safeMessage(new AppError("validation_error", "Choose an image."))).toBe("Choose an image.");
  });

  it("replaces anything unexpected with a generic message", () => {
    // A raw TypeError message can contain file paths and internal identifiers.
    const leaky = new TypeError("Cannot read properties of undefined at /srv/app/src/lib/db/scans.ts:42");
    expect(safeMessage(leaky)).not.toContain("/srv/app");
    expect(safeMessage(leaky)).toBe("Something went wrong. Please try again.");
  });

  it("handles non-Error throwables", () => {
    expect(safeMessage("a string")).toBe("Something went wrong. Please try again.");
    expect(safeMessage(undefined)).toBe("Something went wrong. Please try again.");
    expect(safeMessage({ secret: "token" })).toBe("Something went wrong. Please try again.");
  });
});