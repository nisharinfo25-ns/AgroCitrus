/**
 * GET /api/health
 *
 * Liveness + readiness. Reports the *real* state of every dependency:
 * Supabase, Storage, the dataset and the model. When a dependency is missing
 * the endpoint still returns 200 with `status: "degraded"` and an actionable
 * message, because a "not set up yet" instance is healthy - it just is not
 * ready to predict.
 */

import { NextResponse } from "next/server";

import { isSupabaseConfigured } from "@/lib/env";
import { checkPython } from "@/lib/ml/client";
import { createServerClientScoped, isAdminConfigured } from "@/lib/supabase/client";
import type { HealthResponse } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERSION = "1.0.0";

/** The slice of `citrusguard dataset status` this endpoint reads. */
interface DatasetStatusCli {
  manifest?: { image_count?: number } | null;
}

/** The slice of `citrusguard model status` this endpoint reads. */
interface ModelStatusCli {
  status?: { configured?: boolean; reason?: string };
}

export async function GET() {
  const checks: HealthResponse["checks"] = {
    supabase: { ok: false, message: "" },
    storage: { ok: false, message: "" },
    dataset: { ok: false, message: "" },
    model: { ok: false, message: "" },
  };

  // ---- Supabase ------------------------------------------------------- //
  if (!isSupabaseConfigured) {
    checks.supabase = {
      ok: false,
      message:
        "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Copy .env.example to .env.local.",
    };
  } else {
    try {
      const supabase = await createServerClientScoped();
      const { error } = await supabase.from("dataset_metadata").select("id").limit(1);
      if (error) {
        checks.supabase = {
          ok: false,
          message: `Supabase is reachable but the query failed: ${error.message}. Did you run the migrations?`,
        };
      } else {
        checks.supabase = { ok: true, message: "Connected." };
        // Storage is only meaningful once Postgres answers.
        checks.storage = {
          ok: isAdminConfigured(),
          message: isAdminConfigured()
            ? "Service role key is configured."
            : "SUPABASE_SERVICE_ROLE_KEY is not set. Uploaded images and model artifacts cannot be stored.",
        };
      }
    } catch (error) {
      checks.supabase = {
        ok: false,
        message: `Could not reach Supabase: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  // ---- Dataset -------------------------------------------------------- //
  try {
    const { execCliStatus } = await import("@/lib/ml/cli");
    const status = await execCliStatus<DatasetStatusCli>(["dataset", "status"]);
    const manifest = status.manifest;
    checks.dataset = manifest
      ? {
          ok: true,
          message: `${manifest.image_count ?? "an unknown number of"} images prepared locally.`,
          details: manifest,
        }
      : { ok: false, message: "Dataset setup required. Run `npm run ml:dataset:download`." };
  } catch (error) {
    checks.dataset = {
      ok: false,
      message: error instanceof Error ? error.message : "The dataset pipeline is unavailable.",
    };
  }

  // ---- Model ---------------------------------------------------------- //
  try {
    const { execCliStatus } = await import("@/lib/ml/cli");
    const status = await execCliStatus<ModelStatusCli>(["model", "status"]);
    checks.model = status.status?.configured
      ? { ok: true, message: "A production model is deployed." }
      : {
          ok: false,
          message: status.status?.reason ?? "Model is not configured. Run `npm run ml:model:export`.",
        };
  } catch (error) {
    checks.model = {
      ok: false,
      message: error instanceof Error ? error.message : "The model pipeline is unavailable.",
    };
  }

  // ---- Python --------------------------------------------------------- //
  if (!checks.model.ok && !checks.dataset.ok) {
    const python = await checkPython();
    if (!python.available) {
      checks.dataset.message = `${checks.dataset.message} (${python.message})`;
    }
  }

  const ready = Object.values(checks).every((check) => check.ok);
  const body: HealthResponse = {
    status: ready ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    version: VERSION,
    checks,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}