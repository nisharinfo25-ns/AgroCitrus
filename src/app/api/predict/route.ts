/**
 * POST /api/predict
 *
 * The core endpoint. Order of operations is deliberate and each step can stop
 * the request before a single byte reaches the model:
 *
 *   1. auth            - the caller must be signed in
 *   2. rate limit      - per user, to bound model cost
 *   3. model presence  - a production model must exist in Postgres
 *   4. upload shape    - size, declared MIME, magic bytes
 *   5. quality gate    - measured by the ML worker (blur / exposure / size)
 *   6. inference       - explicit Leaf-vs-Fruit router, then the matched
 *                        disease head (or a refusal, never a guess)
 *   7. artefact upload - original / processed / explanation to `scan-images`
 *   8. persist         - one immutable `scans` row
 *
 * A quality rejection still produces a persisted record (`rejected_quality`),
 * and a stage-1 abstention produces one too (`failed`, code `routing_uncertain`),
 * so the user's history reflects what they actually attempted - but no
 * prediction is invented for either.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { APP_CONFIG, BUCKETS } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { insertScan } from "@/lib/db/scans";
import { describeDbError, isMissingSchemaError } from "@/lib/db/schema";
import { ensureProductionBundle, runPrediction, warmInferenceServer } from "@/lib/ml/client";
import { createAdminClient } from "@/lib/supabase/client";
import {
  assertSameOrigin,
  enforceRateLimit,
  fail,
  formBoolean,
  ok,
  safeStorageKey,
  serverLog,
  validateUpload,
} from "@/lib/server";
import type { ModelVersion, PredictionPayload, QualityMetrics } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Grad-CAM + model load on a cold cache routinely exceeds the default budget.
export const maxDuration = 120;

const PredictOptions = z
  .object({
    // Defaults to ON: the Grad-CAM overlay is a core feature, and callers
    // opt *out* by sending enable_gradcam=false.
    enable_gradcam: z.boolean().default(true),
    /**
     * Explicit part choice from the uploader.
     *
     * When present it takes precedence over the automatic router and is
     * recorded as `routing_state="user_selected"`, so the result never claims a
     * classifier decided something the user did. It exists so someone can
     * rescue a scan the router declined to route instead of being stuck. The
     * value is enum-validated here and again in the Python worker; an unknown
     * value is a 400, not a silently ignored hint.
     */
    input_type_hint: z.enum(["leaf", "fruit"]).optional(),
  })
  .default({ enable_gradcam: true });

const RATE_LIMIT = { limit: 20, windowMs: 10 * 60_000, scope: "prediction" };

export async function POST(request: Request) {
  let userId: string | undefined;
  try {
    assertSameOrigin(request);

    const { user, supabase } = await requireUser();
    userId = user.id;

    enforceRateLimit(request, userId, RATE_LIMIT);

    // ---- 3. a production model must exist --------------------------- //
    const { data: modelRow, error: modelError } = await supabase
      .from("model_versions")
      .select("id, version, model_checksum, classes, severity_support")
      .eq("status", "production")
      .maybeSingle();

    if (modelError) {
      // An unmigrated database is a setup state with a correct, actionable
      // status code, not a 500. Reporting it as `internal_error` sent the client
      // hunting for a server fault when the fix is to apply the schema.
      if (isMissingSchemaError(modelError)) {
        serverLog("predict", describeDbError("model lookup failed", modelError));
        throw new AppError(
          "model_not_configured",
          "Model is not configured. The database schema has not been applied yet.",
        );
      }
      serverLog("predict", "model lookup failed", modelError);
      throw new AppError("internal_error", "The model configuration could not be read.");
    }
    if (!modelRow) {
      throw new AppError(
        "model_not_configured",
        "Model is not configured. No production model has been deployed yet.",
      );
    }
    const model = modelRow as Pick<ModelVersion, "id" | "version" | "model_checksum" | "classes">;

    // ---- 4. upload validation ---------------------------------------- //
    const upload = await validateUpload(request);
    const options = PredictOptions.parse({
      enable_gradcam: formBoolean(upload.fields.enable_gradcam, true),
      input_type_hint: upload.fields.input_type_hint || undefined,
    });

    // ---- 5 + 6. quality gate and inference -------------------------- //
    const admin = createAdminClient();
    let bundleDir = "";

    if (!APP_CONFIG.inferenceUrl) {
      const bundle = await ensureProductionBundle(admin, {
        expectedVersion: model.version,
        expectedChecksum: model.model_checksum,
      });
      bundleDir = bundle.dir;

      // Warm the long-lived inference server once per bundle.
      const warmSeconds = await warmInferenceServer(bundle.dir);
      if (warmSeconds !== null) {
        serverLog("predict", `inference server warmed bundle ${bundle.version} in ${warmSeconds.toFixed(2)}s`);
      }
    }

    const outcome = await runPrediction({
      imageBytes: upload.bytes,
      extension: upload.extension,
      bundleDir,
      enableGradCam: options.enable_gradcam,
      inputTypeHint: options.input_type_hint ?? null,
    });

    const scanId = crypto.randomUUID();

    // ---- quality gate rejected: persist the attempt, invent nothing --- //
    if (!outcome.ok) {
      const code = outcome.error?.code;
      const message =
        outcome.error?.message ?? "The image could not be analysed. Please try another image.";

      if (code === "image_quality_insufficient") {
        const stored = await uploadScanArtefacts(admin, {
          userId: user.id,
          scanId,
          original: upload.bytes,
        });
        await insertScan(supabase, {
          userId: user.id,
          scanId,
          imageKey: stored.original,
          payload: rejectedPayload(outcome.quality),
          quality: (outcome.quality as QualityMetrics | null) ?? null,
          state: "rejected_quality",
          errorCode: "image_quality_insufficient",
        }).catch((error) => serverLog("predict", "could not persist rejected scan", error));
      }

      // ---- stage 1 abstained: no disease head ran, no Grad-CAM exists --- //
      // The worker still returns the measurements it DID take (the router's
      // probability distribution), so the refusal is explainable rather than a
      // bare failure. Persisted as `failed` with a machine-readable code; the
      // scan is genuinely unclassified, so `status` stays null.
      if (code === "routing_uncertain") {
        const abstained =
          (outcome.payload as unknown as PredictionPayload | null) ??
          abstainedPayload(outcome.quality);
        const stored = await uploadScanArtefacts(admin, {
          userId: user.id,
          scanId,
          original: upload.bytes,
        });
        await insertScan(supabase, {
          userId: user.id,
          scanId,
          imageKey: stored.original,
          payload: abstained,
          quality: (outcome.quality as QualityMetrics | null) ?? null,
          state: "failed",
          errorCode: "routing_uncertain",
        }).catch((error) => serverLog("predict", "could not persist abstained scan", error));

        return NextResponse.json(
          {
            error: {
              code: "routing_uncertain",
              message,
              reasons: [],
              quality: outcome.quality ?? null,
              routing: {
                state: abstained.routing_state ?? "uncertain",
                confidence: abstained.routing_confidence ?? abstained.input_type_confidence ?? null,
                threshold: abstained.routing_threshold ?? null,
                method: abstained.routing_method ?? null,
                part_probabilities: abstained.part_probabilities ?? [],
              },
            },
          },
          { status: 422 },
        );
      }

      const status = code === "image_quality_insufficient" ? 422 : 500;
      return NextResponse.json(
        {
          error: {
            code: code ?? "prediction_failed",
            message,
            reasons: (outcome.quality as QualityMetrics | null)?.reasons ?? [],
            quality: outcome.quality ?? null,
          },
        },
        { status },
      );
    }

    const payload = outcome.payload as unknown as PredictionPayload;
    const quality = (outcome.quality as QualityMetrics | null) ?? payload.quality ?? null;

    // ---- 7. upload artefacts ----------------------------------------- //
    const stored = await uploadScanArtefacts(admin, {
      userId: user.id,
      scanId,
      original: upload.bytes,
      processed: outcome.artifacts.processed,
      heatmap: outcome.artifacts.heatmap,
      overlay: outcome.artifacts.overlay,
    });

    // ---- 8. persist --------------------------------------------------- //
    const scan = await insertScan(supabase, {
      userId: user.id,
      scanId,
      imageKey: stored.original,
      processedKey: stored.processed,
      heatmapKey: stored.heatmap,
      explanationKey: stored.overlay,
      payload,
      quality,
      state: payload.is_low_confidence ? "low_confidence" : "ok",
    });

    // Mint signed URLs so the result page can render without a second request.
    const { signScanImages } = await import("@/lib/db/scans");
    const urls = await signScanImages(admin, {
      image_path: stored.original,
      heatmap_path: stored.heatmap,
      explanation_path: stored.overlay,
    });

    return ok({
      scan: { ...scan, ...urls },
      prediction: payload,
      warnings: buildWarnings(payload, quality),
    });
  } catch (error) {
    return fail(error, "predict");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal payload for a quality-rejected scan: no class is invented. */
function rejectedPayload(quality: unknown): PredictionPayload {
  const metrics = quality as QualityMetrics | null;
  return {
    input_type: null,
    input_type_confidence: null,
    predicted_class: "unclassified",
    predicted_class_display: "Not analysed",
    confidence: 0,
    // NOT "diseased": the image was never classified. Recording a verdict here
    // would be a fabricated diagnosis for an image the pipeline refused.
    status: null,
    is_low_confidence: true,
    min_confidence_threshold: 0,
    probabilities: [],
    part_probabilities: [],
    quality: metrics,
    severity: null,
    severity_supported: false,
    severity_unavailable_reason: "Severity analysis is not available for this model.",
    gradcam: null,
    model_name: "",
    model_version: "",
    dataset_version: "",
    explanation_note: "",
    latency_ms: 0,
    routing_state: "uncertain",
  };
}

/**
 * Fallback payload for a stage-1 abstention when the worker returned no result
 * body at all. Same rule: no class, no verdict, no explanation image.
 */
function abstainedPayload(quality: unknown): PredictionPayload {
  return {
    ...rejectedPayload(quality),
    routing_message:
      "Unable to confidently determine whether this is a citrus leaf or fruit. " +
      "Please upload a clearer, closer image of a single citrus leaf or fruit.",
  };
}

interface ArtefactUpload {
  userId: string;
  scanId: string;
  original: Buffer;
  processed?: { bytes: Buffer; extension: string } | null;
  heatmap?: Buffer | null;
  overlay?: Buffer | null;
}

async function uploadScanArtefacts(
  admin: ReturnType<typeof createAdminClient>,
  input: ArtefactUpload,
): Promise<{
  original: string;
  processed: string | null;
  heatmap: string | null;
  overlay: string | null;
}> {
  const bucket = admin.storage.from(BUCKETS.scans);

  const put = async (folder: string, filename: string, bytes: Buffer, contentType: string) => {
    // The key prefix is `{user_id}/{scan_id}/...` - exactly the shape the RLS
    // storage policies in 0001_core_schema.sql require. Built through
    // `safeStorageKey` rather than by interpolation so the prefix cannot be
    // escaped by a crafted value, and so the policy-relevant shape is enforced
    // in one place instead of being assumed here.
    const key = safeStorageKey(input.userId, input.scanId, folder, filename);
    // `false` (not the string) is the documented type. It is also the default,
    // but stated explicitly: a scan key includes a fresh UUID, so an overwrite
    // would mean a collision, and silently allowing one would mask a bug.
    const { error } = await bucket.upload(key, bytes, { contentType, upsert: false });
    if (error) {
      // A missing artefact must not lose the scan record itself.
      serverLog("predict", `upload failed for ${key}`, error);
      throw new AppError("storage_error", "The scan images could not be stored.");
    }
    return key;
  };

  const original = await put("original", `upload.${extensionFor(input.original)}`, input.original, contentTypeFor(input.original));

  const processed = input.processed
    ? await put("processed", `processed.${input.processed.extension}`, input.processed.bytes, "image/png")
    : null;
  const heatmap = input.heatmap ? await put("explanation", "heatmap.png", input.heatmap, "image/png") : null;
  const overlay = input.overlay ? await put("explanation", "overlay.png", input.overlay, "image/png") : null;

  return { original, processed, heatmap, overlay };
}

function extensionFor(bytes: Buffer): "jpg" | "png" | "webp" {
  if (bytes[0] === 0x89) return "png";
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return "webp";
  return "jpg";
}

function contentTypeFor(bytes: Buffer): string {
  return { png: "image/png", webp: "image/webp", jpg: "image/jpeg" }[extensionFor(bytes)];
}

/**
 * Honest, actionable notices. Every string here is derived from a measured
 * value - there is no branch that emits an invented caveat.
 */
function buildWarnings(payload: PredictionPayload, quality: QualityMetrics | null): string[] {
  const warnings: string[] = [];

  if (payload.is_low_confidence) {
    warnings.push(
      `Model confidence is ${(payload.confidence * 100).toFixed(1)}%, below the ` +
        `${(payload.min_confidence_threshold * 100).toFixed(0)}% threshold set for this model. ` +
        "Treat this result as a suggestion and re-scan with a clearer photo if possible.",
    );
  }

  if (payload.input_type_confidence !== null && payload.input_type_confidence < 0.7) {
    warnings.push(
      "The model was not confident whether this is a leaf or a fruit, so the disease prediction may not apply.",
    );
  }

  if (payload.routing_state === "heuristic") {
    warnings.push(
      "This model bundle ships no trained leaf/fruit router, so the part decision used a fallback comparison of the two disease heads rather than a dedicated classifier.",
    );
  }

  if (quality && !quality.passed) {
    warnings.push("The uploaded image did not pass every quality check, which reduces prediction reliability.");
  }

  if (!payload.severity_supported) {
    warnings.push("Severity analysis is not available for this model.");
  }

  // A near-tie between the top two classes is worth stating explicitly.
  const [top, second] = payload.probabilities ?? [];
  if (top && second && Math.abs(top.probability - second.probability) < 0.1) {
    warnings.push(
      `The top two classes are close (${(top.probability * 100).toFixed(1)}% vs ${(second.probability * 100).toFixed(1)}%), so the result is ambiguous.`,
    );
  }

  return warnings;
}