/**
 * Scan persistence.
 *
 * All reads and writes go through the RLS-scoped client, so Postgres is the
 * authority on ownership. The service-role client is never used to serve a
 * user's own scan data - only to mint signed URLs, and only after RLS has
 * already confirmed the row belongs to the caller.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { BUCKETS } from "@/lib/env";
import { describeDbError, isMissingSchemaError } from "@/lib/db/schema";
import { AppError, serverLog } from "@/lib/server";
import type { SupabaseClient } from "@supabase/supabase-js";


import type {
  HealthStatus,
  InputType,
  PredictionState,
  PredictionPayload,
  QualityMetrics,
  Scan,
  ScanWithUrls,
  Severity,
} from "@/types";

/**
 * Best-effort image signing.
 *
 * Minting a signed URL needs the service-role key, which is an optional piece of
 * deployment configuration. It is used here for *optional* decoration - scan
 * thumbnails on the dashboard and history pages - and never for authorization,
 * which Postgres RLS has already decided by the time this runs.
 *
 * So a missing key must degrade to "no thumbnail", not crash the page. The
 * previous behaviour was to call `createAdminClient()` inline in a page
 * component, where its `MissingEnvError` propagated out of the Server
 * Component render and took the entire dashboard down: the token request
 * succeeded, the session cookie was set, the redirect worked, and the
 * destination still failed to render. Hence the guard and the null result.
 *
 * Never logs or returns the key itself.
 */
export async function signScanImagesSafe(
  admin: SupabaseClient<any> | null,
  scan: Pick<Scan, "image_path" | "heatmap_path" | "explanation_path">,
  expiresIn = 3600,
): Promise<SignedUrlSet> {
  if (!admin) return { image_url: null, heatmap_url: null, overlay_url: null };
  return signScanImages(admin, scan, expiresIn);
}
/**
 * A Supabase client bound to the caller's session.
 *
 * Shared rather than redeclared per module: the whole point of passing this
 * instead of the service-role client is that RLS stays in force, so the type
 * should carry one name everywhere it is used.
 */
export type ScopedClient = SupabaseClient<any>;

export interface SaveScanInput {
  userId: string;
  scanId?: string;
  imageKey: string;
  processedKey?: string | null;
  heatmapKey?: string | null;
  explanationKey?: string | null;
  payload: PredictionPayload;
  quality?: QualityMetrics | null;
  state?: PredictionState;
  /**
   * Machine-readable reason a scan produced no verdict, e.g.
   * `routing_uncertain` when stage 1 refused to choose a disease head. Null on
   * every ordinary successful scan.
   */
  errorCode?: string | null;
}

/** Insert a scan. The RLS policy enforces `user_id = auth.uid()`. */
export async function insertScan(
  supabase: ScopedClient,
  input: SaveScanInput,
): Promise<Scan> {
  const { payload } = input;
  const row = {
    id: input.scanId ?? randomUUID(),
    user_id: input.userId,
    image_path: input.imageKey,
    processed_path: input.processedKey ?? null,
    heatmap_path: input.heatmapKey ?? null,
    explanation_path: input.explanationKey ?? null,
    input_type: (payload.input_type ?? null) as InputType | null,
    input_type_confidence: payload.input_type_confidence ?? null,
    predicted_class: payload.predicted_class,
    predicted_class_display: payload.predicted_class_display,
    confidence: payload.confidence,
    status: (payload.status ?? null) as HealthStatus | null,
    prediction_state: input.state ?? (payload.is_low_confidence ? "low_confidence" : "ok"),
    is_low_confidence: payload.is_low_confidence,
    // Severity is null unless the model genuinely supports it.
    severity: (payload.severity ?? null) as Severity | null,
    probabilities: payload.probabilities ?? [],
    part_probabilities: payload.part_probabilities ?? [],
    quality_metrics: input.quality ?? payload.quality ?? null,
    explanation_note: payload.gradcam?.disclaimer ?? payload.explanation_note ?? null,
    model_version: payload.model_version ?? null,
    model_name: payload.model_name ?? null,
    dataset_version: payload.dataset_version ?? null,
    latency_ms: payload.latency_ms ?? null,
    error_code: input.errorCode ?? null,
  };

  const { data, error } = await supabase.from("scans").insert(row).select("*").single();

  if (error) {
    serverLog("scans", "insert failed", error);
    throw new AppError("storage_error", "The scan could not be saved.");
  }
  return data as Scan;
}

export interface ListScansParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: "healthy" | "diseased" | "all";
  inputType?: InputType | "all";
  lowConfidence?: boolean;
  sort?: "newest" | "oldest" | "confidence";
}

export interface ListScansResult {
  scans: Scan[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * List the caller's scans. RLS guarantees only their own rows are returned;
 * no `user_id` filter is accepted from the client, which means a user cannot
 * request another user's history even by tampering with query parameters.
 */
export async function listScans(supabase: ScopedClient, params: ListScansParams = {}): Promise<ListScansResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, params.pageSize ?? 12));
  const from = (page - 1) * pageSize;

  let query = supabase
    .from("scans")
    .select(
      "id, user_id, image_path, processed_path, explanation_path, heatmap_path, input_type, input_type_confidence, predicted_class, predicted_class_display, confidence, status, prediction_state, is_low_confidence, severity, probabilities, part_probabilities, quality_metrics, explanation_note, model_version, model_name, dataset_version, latency_ms, error_code, created_at",
      { count: "exact" },
    )
    .range(from, from + pageSize - 1);

  if (params.status && params.status !== "all") {
    query = query.eq("status", params.status);
  }
  if (params.inputType && params.inputType !== "all") {
    query = query.eq("input_type", params.inputType);
  }
  if (params.lowConfidence) {
    query = query.eq("is_low_confidence", true);
  }
  if (params.search?.trim()) {
    const term = params.search.trim();
    // Escape LIKE metacharacters so a search term cannot become a wildcard.
    const escaped = term.replace(/[%_\\]/g, (m) => `\\${m}`);
    query = query.or(
      `predicted_class_display.ilike.%${escaped}%,predicted_class.ilike.%${escaped}%,model_version.ilike.%${escaped}%`,
    );
  }

  query =
    params.sort === "oldest"
      ? query.order("created_at", { ascending: true })
      : params.sort === "confidence"
        ? query.order("confidence", { ascending: false }).order("created_at", { ascending: false })
        : query.order("created_at", { ascending: false });

  const { data, error, count } = await query;
  if (error) {
    if (isMissingSchemaError(error)) {
      serverLog("scans", describeDbError("list scans: database schema is not applied yet", error));
      return { scans: [], total: 0, page, pageSize, totalPages: 1 };
    }
    serverLog("scans", "list failed", error);
    throw new AppError("storage_error", "Your scan history could not be loaded.");
  }

  const total = count ?? 0;
  return {
    scans: (data ?? []) as Scan[],
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Fetch a single scan. RLS makes this return null for someone else's row. */
export async function getScan(supabase: ScopedClient, scanId: string): Promise<Scan | null> {
  if (!isUuid(scanId)) return null;
  const { data, error } = await supabase.from("scans").select("*").eq("id", scanId).maybeSingle();
  if (error) {
    serverLog("scans", "get failed", error);
    return null;
  }
  return (data as Scan) ?? null;
}

/** Delete a scan row. RLS restricts this to the owner. */
export async function deleteScan(supabase: ScopedClient, scanId: string): Promise<boolean> {
  if (!isUuid(scanId)) return false;
  const { error, count } = await supabase
    .from("scans")
    .delete({ count: "exact" })
    .eq("id", scanId);
  if (error) {
    serverLog("scans", "delete failed", error);
    throw new AppError("storage_error", "The scan could not be deleted.");
  }
  return (count ?? 0) > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// --------------------------------------------------------------------------
// Signed URLs
// --------------------------------------------------------------------------
export interface SignedUrlSet {
  image_url: string | null;
  heatmap_url: string | null;
  overlay_url: string | null;
}

/**
 * Mint short-lived signed URLs for a scan's images.
 *
 * The bucket is private, so this is the only way the browser can render a scan.
 * `paths` must already be authorised by an RLS-filtered read.
 */
export async function signScanImages(
  admin: SupabaseClient<any>,
  scan: Pick<Scan, "image_path" | "heatmap_path" | "explanation_path">,
  expiresIn = 3600,
): Promise<SignedUrlSet> {
  const bucket = admin.storage.from(BUCKETS.scans);
  const sign = async (path: string | null): Promise<string | null> => {
    if (!path) return null;
    try {
      const { data, error } = await bucket.createSignedUrl(path, expiresIn);
      if (error) {
        serverLog("scans", `signing failed for ${path}`, error);
        return null;
      }
      return data?.signedUrl ?? null;
    } catch (error) {
      serverLog("scans", `signing threw for ${path}`, error);
      return null;
    }
  };

  const [image, heatmap, overlay] = await Promise.all([
    sign(scan.image_path),
    sign(scan.heatmap_path),
    sign(scan.explanation_path),
  ]);
  return { image_url: image, heatmap_url: heatmap, overlay_url: overlay };
}

/**
 * Remove every stored artefact for a scan. Best-effort.
 *
 * The layout is `{user_id}/{scan_id}/{original,processed,explanation}/file`, so
 * this walks one level deeper than the scan prefix. Listing only the prefix
 * would return three *folders*, and removing them as if they were objects would
 * fail silently - leaving the user's images behind after the row is gone, with
 * nothing left to tell anyone they exist.
 */
export async function deleteScanFiles(
  admin: SupabaseClient<any>,
  userId: string,
  scanId: string,
): Promise<void> {
  // Validated before the try block, and deliberately *not* swallowed: a crafted
  // prefix would let one user's delete reach another's objects. The callers
  // already check these are UUIDs, so reaching this is a programming error, and
  // failing loudly beats logging it and leaving the files in place.
  if (!isUuid(userId) || !isUuid(scanId)) {
    throw new AppError("validation_error", "Invalid storage path.");
  }
  const prefix = `${userId}/${scanId}`;
  try {
    const bucket = admin.storage.from(BUCKETS.scans);
    const { data: entries, error } = await bucket.list(prefix, { limit: 1000 });
    if (error) throw error;

    const paths: string[] = [];
    for (const entry of entries ?? []) {
      const entryPath = `${prefix}/${entry.name}`;
      // `id` is null for a folder and a string for a real object.
      if (entry.id === null) {
        const { data: children } = await bucket.list(entryPath, { limit: 1000 });
        for (const child of children ?? []) paths.push(`${entryPath}/${child.name}`);
      } else {
        paths.push(entryPath);
      }
    }

    if (paths.length > 0) {
      const { error: removeError } = await bucket.remove(paths);
      if (removeError) throw removeError;
    }
  } catch (error) {
    // A missing object must not block the database row from being removed.
    serverLog("scans", "file cleanup failed", error);
  }
}
