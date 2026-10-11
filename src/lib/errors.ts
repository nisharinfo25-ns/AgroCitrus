/**
 * Typed application errors and the single place that turns them into HTTP.
 *
 * Rules enforced here:
 *   - technical detail (`detail`, stack traces) is logged server-side only;
 *   - the message returned to the browser is always safe to display;
 *   - unexpected errors become a generic 500 with no internal detail.
 */

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "image_invalid"
  | "image_quality_insufficient"
  | "routing_uncertain"
  | "model_not_configured"
  | "dataset_setup_required"
  | "dataset_download_failed"
  | "dataset_validation_failed"
  | "prediction_failed"
  | "storage_error"
  | "rate_limited"
  | "config_error"
  | "internal_error";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 400,
  image_invalid: 422,
  image_quality_insufficient: 422,
  // A refusal, not a server fault: the request was fine, the pipeline chose not
  // to guess. 422 keeps it out of the "our bug" bucket.
  routing_uncertain: 422,
  model_not_configured: 503,
  dataset_setup_required: 409,
  dataset_download_failed: 502,
  dataset_validation_failed: 422,
  prediction_failed: 500,
  storage_error: 502,
  rate_limited: 429,
  config_error: 500,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: string;
  readonly extra?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: { detail?: string; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.detail = options.detail;
    this.extra = options.extra;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.extra ?? {}) } };
  }
}

export const unauthorized = (message = "You must be signed in to do that.") =>
  new AppError("unauthorized", message);

export const forbidden = (message = "You do not have permission to do that.") =>
  new AppError("forbidden", message);

export const notFound = (message = "The requested resource was not found.") =>
  new AppError("not_found", message);

export const validationError = (message: string, extra?: Record<string, unknown>) =>
  new AppError("validation_error", message, { extra });

export const imageInvalid = (message: string, detail?: string) =>
  new AppError("image_invalid", message, { detail });

export const modelNotConfigured = (message = "Model is not configured.") =>
  new AppError("model_not_configured", message);

export const rateLimited = (message = "Too many requests. Please slow down and try again shortly.") =>
  new AppError("rate_limited", message);

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Message safe to show an end user for any thrown value. */
export function safeMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "Something went wrong. Please try again.";
}
