/**
 * Server-side utilities: response envelopes, rate limiting, image validation
 * and the Python worker bridge.
 */

import "server-only";

import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";

import { AppError, safeMessage, statusForCode, type ErrorCode } from "@/lib/errors";
import { APP_CONFIG } from "@/lib/env";

/**
 * Render an unknown thrown value as something a human can act on.
 *
 * PostgREST/Supabase errors are **plain objects**, not `Error` instances, so
 * `String(error)` produces the literal string `[object Object]`. That is what
 * every `[citrusguard:*]` line used to end with, which made the logs useless for
 * exactly the failures they exist to explain - an operator could see that
 * something failed but not that `public.scans` did not exist.
 *
 * Only four named fields are read. The whole object is never stringified, so a
 * value that happened to carry request headers or credentials cannot leak into a
 * log line by accident.
 */
function describeLoggedError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return "null";
  if (typeof error !== "object") return String(error);

  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.code === "string" && record.code !== "") parts.push(`[${record.code}]`);
  for (const field of ["message", "details", "hint"] as const) {
    const value = record[field];
    // Skip "": PostgREST sends empty strings for fields that do not apply.
    if (typeof value === "string" && value !== "") parts.push(value);
  }
  if (parts.length > 0) return parts.join(" ");

  try {
    return JSON.stringify(record).slice(0, 300);
  } catch {
    return "(unserialisable error)";
  }
}

/** Log with a request tag. Technical detail never reaches the response body. */
export function serverLog(scope: string, message: string, error?: unknown): void {
  const suffix = error === undefined ? "" : ` :: ${describeLoggedError(error)}`;
  // eslint-disable-next-line no-console -- server-side structured logging
  console.error(`[citrusguard:${scope}] ${message}${suffix}`);
  if (error instanceof Error && error.stack && process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console -- developer diagnostics only
    console.error(error.stack);
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, { status: 200, ...init });
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json(data as object, { status: 201 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * The single error funnel for every API route.
 *
 * `AppError` messages are written to be user-facing. Anything else is logged
 * with its stack and replaced by a generic message.
 */
export function fail(error: unknown, scope = "api"): NextResponse {
  if (error instanceof AppError) {
    if (error.status >= 500) serverLog(scope, `${error.code}: ${error.message}`, error);
    return NextResponse.json(error.toJSON(), { status: error.status });
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: "The request was not valid.",
          fields: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 },
    );
  }

  serverLog(scope, "Unhandled error", error);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong. Please try again." } },
    { status: 500 },
  );
}

export async function parseBody<T>(request: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("validation_error", "The request body was not valid JSON.");
  }
  return schema.parse(raw);
}

/** Assert the caller is same-origin, mitigating cross-site POSTs. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return; // same-origin form posts and server-to-server calls omit it
  const host = request.headers.get("host");
  if (!host) return;
  try {
    if (new URL(origin).host !== host) {
      throw new AppError("forbidden", "Cross-origin request rejected.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("forbidden", "Cross-origin request rejected.");
  }
}

// --------------------------------------------------------------------------
// Rate limiting (in-memory, per-instance)
// --------------------------------------------------------------------------
// Adequate for a single-instance deployment. Behind multiple instances, swap
// the store for Redis; the interface is intentionally tiny.
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(key, bucket);
    if (buckets.size > 10_000) pruneBuckets(now);
    return { allowed: true, remaining: limit - 1, resetAt: bucket.resetAt };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }
  return { allowed: true, remaining: limit - existing.count, resetAt: existing.resetAt };
}

function pruneBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Best-effort client IP for rate-limit keys. */
export function clientKey(request: Request, userId?: string): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "anonymous";
  return `ip:${ip}`;
}

export function enforceRateLimit(
  request: Request,
  userId: string | undefined,
  { limit, windowMs, scope }: { limit: number; windowMs: number; scope: string },
): void {
  const result = rateLimit(`${scope}:${clientKey(request, userId)}`, limit, windowMs);
  if (!result.allowed) {
    const seconds = Math.ceil((result.resetAt - Date.now()) / 1000);
    throw new AppError("rate_limited", `Too many ${scope} requests. Please try again in ${seconds}s.`);
  }
}

// --------------------------------------------------------------------------
// Image validation (before anything touches the model)
// --------------------------------------------------------------------------
export const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/**
 * Types that mean "the client did not tell us", not "this is a real format".
 *
 * `application/octet-stream` is what many HTTP clients and some browsers send
 * when they cannot classify a file, and multipart reconstruction substitutes it
 * for a missing `Content-Type` on the part. Rejecting it would refuse a valid
 * JPEG; the magic-byte check below is the authority on what the bytes are.
 */
const UNDECLARED_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** Magic-byte sniffing. The declared MIME type is never trusted on its own. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // JPEG: FF D8 FF
  if (view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8 && view.getUint8(2) === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    view.getUint8(0) === 0x89 &&
    view.getUint8(1) === 0x50 &&
    view.getUint8(2) === 0x4e &&
    view.getUint8(3) === 0x47
  ) {
    return "image/png";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    view.getUint8(0) === 0x52 &&
    view.getUint8(1) === 0x49 &&
    view.getUint8(2) === 0x46 &&
    view.getUint8(3) === 0x46 &&
    view.getUint8(8) === 0x57 &&
    view.getUint8(9) === 0x45 &&
    view.getUint8(10) === 0x42 &&
    view.getUint8(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export interface ValidatedUpload {
  bytes: Buffer;
  mime: string;
  size: number;
  extension: "jpg" | "png" | "webp";
  /** The parsed form, so callers can read extra fields without re-parsing. */
  fields: Record<string, string>;
}

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

/**
 * Full upload gate: presence, size, declared type, magic bytes.
 * Runs before upload to Storage so a malformed file never consumes storage.
 */
export async function validateUpload(request: Request): Promise<ValidatedUpload> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError("validation_error", "The upload could not be read as a form submission.");
  }

  const file = form.get("image");
  if (!(file instanceof File)) {
    throw new AppError("image_invalid", "No image was uploaded. Please choose an image file.");
  }
  if (file.size === 0) {
    throw new AppError("image_invalid", "The uploaded file is empty.");
  }

  const maxBytes = APP_CONFIG.maxUploadMb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new AppError(
      "image_invalid",
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${APP_CONFIG.maxUploadMb} MB.`,
    );
  }

  const rawType = (file.type || "").toLowerCase();
  const declared = UNDECLARED_MIME_TYPES.has(rawType) ? "" : rawType;
  if (declared && !ALLOWED_MIME_TYPES.has(declared)) {
    throw new AppError(
      "image_invalid",
      "Unsupported image format. Please upload a JPEG, PNG or WebP image.",
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    throw new AppError(
      "image_invalid",
      "That file is not a readable image. Please upload a JPEG, PNG or WebP photo of a citrus fruit or leaf.",
    );
  }
  if (declared && declared !== sniffed && !(declared === "image/jpg" && sniffed === "image/jpeg")) {
    throw new AppError(
      "image_invalid",
      "The file contents do not match its declared type. Please re-export the image and try again.",
    );
  }

  // Collect the scalar fields alongside the file. A Request body can only be
  // read once, so returning the already-parsed form is what lets callers read
  // options such as `enable_gradcam` without attempting a second parse.
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
  }

  return {
    bytes,
    mime: sniffed,
    size: file.size,
    extension: EXTENSION_BY_MIME[sniffed as keyof typeof EXTENSION_BY_MIME],
    fields,
  };
}

/** Parse a form boolean field the way an HTML checkbox submits it. */
export function formBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1" || value === "on";
}

// --------------------------------------------------------------------------
// Path sanitisation for Supabase Storage keys
// --------------------------------------------------------------------------
const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/**
 * Build a storage key from untrusted parts, rejecting anything that could
 * escape the intended prefix (`..`, absolute paths, empty segments).
 *
 * Dots are permitted inside a segment because the last segment of a key is
 * normally a filename (`upload.jpg`). The traversal cases are rejected
 * separately rather than by banning dots outright, so `a..b` and `.hidden`
 * still work while `..` and `a/../b` do not.
 */
export function safeStorageKey(...segments: string[]): string {
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new AppError("validation_error", "Invalid storage path.");
    }
    // Defence in depth: no storage backend should normalise a key, but a
    // `..` surviving into one would read outside the intended prefix.
    if (segment.includes("..")) {
      throw new AppError("validation_error", "Invalid storage path.");
    }
    if (!SAFE_SEGMENT.test(segment)) {
      throw new AppError("validation_error", "Invalid storage path segment.");
    }
  }
  return segments.join("/");
}

export { AppError, safeMessage, statusForCode };
export type { ErrorCode };
