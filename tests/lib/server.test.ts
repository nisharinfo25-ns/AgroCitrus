import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";
import {
  ALLOWED_MIME_TYPES,
  assertSameOrigin,
  clientKey,
  enforceRateLimit,
  formBoolean,
  rateLimit,
  safeStorageKey,
  sniffImageMime,
  validateUpload,
} from "@/lib/server";

// --------------------------------------------------------------------------
// Fixtures: real magic bytes, not just declared content types.
// --------------------------------------------------------------------------

// `new Uint8Array([...])` rather than `new Uint8Array([...])`: the latter widens
// to `Uint8Array<ArrayBufferLike>`, which is not assignable to `BlobPart`.
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
]);

// The `ArrayBuffer` parameter matters: a bare `Uint8Array` widens to
// `ArrayBufferLike`, which `BlobPart` rejects.
function uploadRequest(
  bytes: Uint8Array<ArrayBuffer>,
  { name = "leaf.jpg", type = "image/jpeg", fields = {} as Record<string, string> } = {},
): Request {
  const form = new FormData();
  form.append("image", new File([bytes], name, { type }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request("http://localhost/api/predict", { method: "POST", body: form });
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error, `expected an AppError, got ${String(error)}`).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

// --------------------------------------------------------------------------

describe("sniffImageMime", () => {
  it("recognises real JPEG, PNG and WebP headers", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("rejects a format the app does not accept, even though it is a valid image", () => {
    // GIF is a legitimate image; accepting it is a product decision, not a
    // correctness one, so the sniff must return null rather than mislabel it.
    expect(sniffImageMime(GIF)).toBeNull();
  });

  it("returns null for input too short to hold a signature", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });

  it("does not accept a JPEG magic number with a wrong third byte", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it("requires WEBP at offset 8, not merely the RIFF header", () => {
    // A RIFF container that is not WebP (e.g. WAV) must not pass.
    const riffWave = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageMime(riffWave)).toBeNull();
  });
});

describe("validateUpload", () => {
  it("accepts a well-formed JPEG and reports the sniffed type", async () => {
    const result = await validateUpload(uploadRequest(JPEG));
    expect(result.mime).toBe("image/jpeg");
    expect(result.extension).toBe("jpg");
    expect(result.size).toBe(JPEG.length);
    expect(Buffer.isBuffer(result.bytes)).toBe(true);
  });

  it("requires an image field", async () => {
    const form = new FormData();
    form.append("note", "hello");
    const request = new Request("http://localhost/api/predict", { method: "POST", body: form });
    await expectAppError(validateUpload(request), "image_invalid");
  });

  it("rejects an empty file", async () => {
    const form = new FormData();
    form.append("image", new File([], "leaf.jpg", { type: "image/jpeg" }));
    const request = new Request("http://localhost/api/predict", { method: "POST", body: form });
    const error = await expectAppError(validateUpload(request), "image_invalid");
    expect(error.message).toMatch(/empty/i);
  });

  it("rejects a file over the size limit and states the limit", async () => {
    // A valid PNG header padded past the limit: it must fail on size, not on
    // format, or the message would mislead the user.
    const big = new Uint8Array(PNG.length + 11 * 1024 * 1024);
    big.set(PNG, 0);
    const error = await expectAppError(
      validateUpload(uploadRequest(big, { name: "huge.png", type: "image/png" })),
      "image_invalid",
    );
    expect(error.message).toMatch(/MB/);
  });

  it("rejects a declared type outside the allowlist", async () => {
    const error = await expectAppError(
      validateUpload(uploadRequest(JPEG, { name: "a.exe", type: "application/x-msdownload" })),
      "image_invalid",
    );
    expect(error.message).toMatch(/JPEG, PNG or WebP/i);
  });

  it("rejects content that is not an image at all", async () => {
    const text = new TextEncoder().encode("MZ this is a windows executable padded out");
    await expectAppError(
      validateUpload(uploadRequest(text, { name: "virus.jpg", type: "image/jpeg" })),
      "image_invalid",
    );
  });

  it("rejects a file whose contents contradict its declared type", async () => {
    // Declared JPEG, actually PNG. Without the mismatch check an attacker could
    // get an arbitrary byte stream past the gate by labelling it image/jpeg.
    const error = await expectAppError(
      validateUpload(uploadRequest(PNG, { name: "sneaky.jpg", type: "image/jpeg" })),
      "image_invalid",
    );
    expect(error.message).toMatch(/do not match/i);
  });

  it("treats the image/jpg alias as equivalent to image/jpeg", async () => {
    // Browsers still submit the non-standard image/jpg; rejecting it would fail
    // a legitimate upload for no security benefit.
    const result = await validateUpload(uploadRequest(JPEG, { type: "image/jpg" }));
    expect(result.mime).toBe("image/jpeg");
  });

  it("falls back to the sniffed type when the client declared none", async () => {
    // A multipart round-trip substitutes application/octet-stream for a missing
    // part Content-Type. Rejecting that would refuse a perfectly good photo, and
    // the magic bytes are the authority anyway.
    for (const type of ["", "application/octet-stream"]) {
      const result = await validateUpload(uploadRequest(PNG, { name: "x", type }));
      expect(result.mime, `declared type ${JSON.stringify(type)}`).toBe("image/png");
      expect(result.extension).toBe("png");
    }
  });

  it("still refuses a non-image sent as octet-stream", async () => {
    const text = new TextEncoder().encode("this is definitely not an image at all");
    await expectAppError(
      validateUpload(uploadRequest(text, { name: "x.bin", type: "application/octet-stream" })),
      "image_invalid",
    );
  });

  it("returns the scalar form fields so the body is not parsed twice", async () => {
    // A Request body can only be read once. Re-parsing to reach an option
    // field would fail, so validateUpload hands the fields back.
    const result = await validateUpload(
      uploadRequest(JPEG, { fields: { enable_gradcam: "true", input_type_hint: "leaf" } }),
    );
    expect(result.fields).toEqual({ enable_gradcam: "true", input_type_hint: "leaf" });
  });

  it("does not include the file itself in `fields`", async () => {
    const result = await validateUpload(uploadRequest(JPEG));
    expect(result.fields.image).toBeUndefined();
  });

  it("rejects a body that is not a form submission", async () => {
    const request = new Request("http://localhost/api/predict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "not-a-file" }),
    });
    await expectAppError(validateUpload(request), "validation_error");
  });
});

describe("ALLOWED_MIME_TYPES", () => {
  it("is exactly the three formats the UI offers", () => {
    expect([...ALLOWED_MIME_TYPES].sort()).toEqual(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
  });
});

describe("safeStorageKey", () => {
  it("joins trusted segments", () => {
    expect(safeStorageKey("user-123", "scan-456", "original", "leaf.jpg")).toBe(
      "user-123/scan-456/original/leaf.jpg",
    );
  });

  it("rejects traversal segments", () => {
    expect(() => safeStorageKey("..")).toThrow(AppError);
    expect(() => safeStorageKey("a", "..")).toThrow(/Invalid storage path/);
    expect(() => safeStorageKey(".")).toThrow(AppError);
  });

  it("rejects embedded separators, so a segment cannot become a directory", () => {
    expect(() => safeStorageKey("a/b")).toThrow(AppError);
    expect(() => safeStorageKey("a\\b")).toThrow(AppError);
  });

  it("rejects an empty segment", () => {
    expect(() => safeStorageKey("a", "")).toThrow(AppError);
  });

  it("rejects characters that have no business in a storage key", () => {
    expect(() => safeStorageKey("leaf photo.jpg")).toThrow(/segment/);
    expect(() => safeStorageKey("leaf$")).toThrow(/segment/);
    expect(() => safeStorageKey("a;b")).toThrow(/segment/);
  });

  it("allows a dot inside a segment, because filenames have extensions", () => {
    // The last segment of a real storage key is `upload.jpg`. Banning dots made
    // this helper unusable for its actual purpose.
    expect(safeStorageKey("user-1", "scan-2", "original", "upload.png")).toBe(
      "user-1/scan-2/original/upload.png",
    );
    expect(() => safeStorageKey("scan.v2")).not.toThrow();
  });

  it("still rejects traversal hidden inside an otherwise valid segment", () => {
    // Defence in depth: no backend should normalise a key, but a surviving
    // `..` would read outside the intended prefix.
    expect(() => safeStorageKey("a..b")).toThrow(/Invalid storage path/);
    expect(() => safeStorageKey("..hidden")).toThrow(/Invalid storage path/);
  });
});

describe("formBoolean", () => {
  it("accepts every form encoding of true", () => {
    expect(formBoolean("true", false)).toBe(true);
    expect(formBoolean("1", false)).toBe(true);
    expect(formBoolean("on", false)).toBe(true); // an HTML checkbox
  });

  it("treats anything else as false", () => {
    expect(formBoolean("false", true)).toBe(false);
    expect(formBoolean("0", true)).toBe(false);
    expect(formBoolean("off", true)).toBe(false);
    expect(formBoolean("no", true)).toBe(false);
  });

  it("falls back only when the field is absent or blank", () => {
    expect(formBoolean(undefined, true)).toBe(true);
    expect(formBoolean(undefined, false)).toBe(false);
    expect(formBoolean("", true)).toBe(true);
  });

  it("does not accept a truthy-looking string as true", () => {
    // `"yes"` from a hand-rolled client must not silently enable Grad-CAM work.
    expect(formBoolean("yes", false)).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  const make = (headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/model/train", { method: "POST", headers });

  it("allows a matching origin", () => {
    expect(() => assertSameOrigin(make({ origin: "http://localhost:3000", host: "localhost:3000" }))).not.toThrow();
  });

  it("rejects a cross-origin POST", () => {
    expect(() =>
      assertSameOrigin(make({ origin: "https://evil.example", host: "localhost:3000" })),
    ).toThrow(/Cross-origin/);
  });

  it("compares host including port, so a different port is rejected", () => {
    expect(() => assertSameOrigin(make({ origin: "http://localhost:4000", host: "localhost:3000" }))).toThrow(
      /Cross-origin/,
    );
  });

  it("allows a request with no Origin header", () => {
    // Same-origin form posts and server-to-server calls omit it; rejecting those
    // would break legitimate use. The session cookie is the actual defence.
    expect(() => assertSameOrigin(make({ host: "localhost:3000" }))).not.toThrow();
  });

  it("rejects an unparseable Origin rather than passing it", () => {
    expect(() => assertSameOrigin(make({ origin: "not-a-url", host: "localhost:3000" }))).toThrow(
      /Cross-origin/,
    );
  });

  it("allows a request with no Host header", () => {
    expect(() => assertSameOrigin(make({ origin: "https://anywhere.example" }))).not.toThrow();
  });
});

describe("rate limiting", () => {
  it("allows up to the limit then refuses", () => {
    const key = `test:${Math.random()}`;
    expect(rateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(rateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(rateLimit(key, 3, 60_000).allowed).toBe(true);
    const fourth = rateLimit(key, 3, 60_000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it("reports the remaining allowance decreasing", () => {
    const key = `test:${Math.random()}`;
    expect(rateLimit(key, 3, 60_000).remaining).toBe(2);
    expect(rateLimit(key, 3, 60_000).remaining).toBe(1);
    expect(rateLimit(key, 3, 60_000).remaining).toBe(0);
  });

  it("starts a fresh window once the old one expires", () => {
    vi.useFakeTimers();
    try {
      const key = `test:${Math.random()}`;
      expect(rateLimit(key, 1, 1_000).allowed).toBe(true);
      expect(rateLimit(key, 1, 1_000).allowed).toBe(false);
      vi.advanceTimersByTime(1_001);
      expect(rateLimit(key, 1, 1_000).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps separate counters per key", () => {
    const a = `test:${Math.random()}`;
    const b = `test:${Math.random()}`;
    rateLimit(a, 1, 60_000);
    expect(rateLimit(a, 1, 60_000).allowed).toBe(false);
    expect(rateLimit(b, 1, 60_000).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request("http://localhost/api/predict", { headers });

  it("prefers the authenticated user over the IP", () => {
    // Keying on IP alone would let one user on a shared NAT exhaust the limit
    // for everyone behind it.
    const request = withHeaders({ "x-forwarded-for": "203.0.113.5" });
    expect(clientKey(request, "user-abc")).toBe("user:user-abc");
  });

  it("uses the first forwarded IP when there is no user", () => {
    const request = withHeaders({ "x-forwarded-for": "203.0.113.5, 198.51.100.1" });
    expect(clientKey(request)).toBe("ip:203.0.113.5");
  });

  it("falls back to x-real-ip, then to anonymous", () => {
    expect(clientKey(withHeaders({ "x-real-ip": "198.51.100.9" }))).toBe("ip:198.51.100.9");
    expect(clientKey(withHeaders({}))).toBe("ip:anonymous");
  });
});

describe("enforceRateLimit", () => {
  it("throws a rate_limited AppError once the limit is passed", () => {
    const scope = `scope-${Math.random()}`;
    const request = new Request("http://localhost/api/predict");
    expect(() => enforceRateLimit(request, "user-1", { limit: 2, windowMs: 60_000, scope })).not.toThrow();
    expect(() => enforceRateLimit(request, "user-1", { limit: 2, windowMs: 60_000, scope })).not.toThrow();
    try {
      enforceRateLimit(request, "user-1", { limit: 2, windowMs: 60_000, scope });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("rate_limited");
      // The message must say how long to wait.
      expect((error as AppError).message).toMatch(/try again in \d+s/);
    }
  });

  it("scopes buckets per user so one user cannot exhaust another's", () => {
    const scope = `scope-${Math.random()}`;
    const request = new Request("http://localhost/api/predict");
    enforceRateLimit(request, "user-1", { limit: 1, windowMs: 60_000, scope });
    expect(() => enforceRateLimit(request, "user-2", { limit: 1, windowMs: 60_000, scope })).not.toThrow();
    expect(() => enforceRateLimit(request, "user-1", { limit: 1, windowMs: 60_000, scope })).toThrow();
  });
});