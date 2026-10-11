/**
 * GET /api/model/status
 *
 * The single source of truth for "is the app able to predict?" and, if not,
 * exactly what is missing. Readable by any signed-in user because the Detect
 * page needs it to decide between the upload form and the setup notice.
 *
 * Two sources are consulted and reported separately:
 *   - `model_versions` where `status = 'production'` - what the API serves;
 *   - the local ML bundle on disk - what this machine can load.
 * A production row with no local artifact is a real, common state after a
 * deploy (the artifact is fetched from Storage on first request), so it is
 * reported as `local: { present: false }` rather than as a failure.
 */

import { requireUser } from "@/lib/auth";
import { APP_CONFIG } from "@/lib/env";
import { execCliStatus } from "@/lib/ml/cli";
import { fail, ok, serverLog } from "@/lib/server";
import type { ModelStatusResponse, ModelVersion } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CliModelStatus {
  status?: {
    configured?: boolean;
    reason?: string;
    manifest?: Record<string, unknown> | null;
  };
  versions?: Array<Record<string, unknown>>;
  production_dir?: string;
}

export async function GET() {
  try {
    const { supabase } = await requireUser();

    const [{ data: rows, error }, cli] = await Promise.all([
      supabase
        .from("model_versions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
      execCliStatus<CliModelStatus | null>(["model", "status"]).catch((cliError) => {
        // A web-only deployment has no Python runtime. That is a state to
        // report, not a reason to 500 the endpoint.
        serverLog("model.status", "local model status unavailable", cliError);
        return null;
      }),
    ]);

    if (error) {
      serverLog("model.status", "model_versions query failed", error);
    }

    const all = (rows ?? []) as ModelVersion[];
    const model = all.find((row) => row.status === "production") ?? null;
    const localConfigured = Boolean(cli?.status?.configured);

    // Versions recorded in Postgres are the authoritative list; the local CLI
    // list is merged in so a version trained on this machine but not yet synced
    // is still visible to the admin.
    const versions = mergeVersions(all, cli);

    const severity_supported = model?.severity_support?.enabled ?? false;
    const minConfidence =
      typeof cli?.status?.manifest?.min_confidence === "number"
        ? (cli.status.manifest.min_confidence as number)
        : APP_CONFIG.minConfidence;

    const body: ModelStatusResponse = {
      configured: Boolean(model),
      status_label: model ? "Ready" : "Model is not configured",
      model,
      versions,
      severity_supported,
      min_confidence: minConfidence,
      message: describe(model, localConfigured, Boolean(cli)),
    };

    return ok(
      {
        ...body,
        local: {
          bundle_present: localConfigured,
          bundle_dir: cli?.production_dir ?? null,
          reason: cli?.status?.reason ?? null,
        },
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return fail(error, "model.status");
  }
}

function describe(model: ModelVersion | null, localConfigured: boolean, cliReachable: boolean): string {
  if (!model) {
    return cliReachable
      ? "Model is not configured. No production model has been deployed. Train and export a version, then promote it."
      : "Model is not configured, and the Python runtime is not available on this server.";
  }
  if (!localConfigured && cliReachable) {
    return `Model ${model.version} is deployed and will be fetched from Supabase Storage on the first prediction.`;
  }
  return `Model ${model.version} is active.`;
}

function mergeVersions(
  rows: ModelVersion[],
  cli: CliModelStatus | null,
): ModelStatusResponse["versions"] {
  const byVersion = new Map<string, ModelStatusResponse["versions"][number]>();

  for (const row of (cli?.versions ?? []) as Array<Record<string, unknown>>) {
    const version = String(row.model_version ?? row.version ?? "");
    if (!version) continue;
    byVersion.set(version, {
      version,
      trained_at: (row.trained_at as string | null) ?? null,
      status: (row.status as ModelStatusResponse["versions"][number]["status"]) ?? "candidate",
      test_accuracy: numberOrNull(row.test_accuracy),
      validation_accuracy: numberOrNull(row.validation_accuracy),
      model_checksum: (row.model_checksum as string | null) ?? null,
      classes: Array.isArray(row.classes) ? (row.classes as string[]) : [],
      notes: typeof row.notes === "string" ? row.notes : "",
    });
  }

  // Postgres wins on conflict: it records promotion, which the filesystem
  // does not know about.
  for (const row of rows) {
    byVersion.set(row.version, {
      version: row.version,
      trained_at: row.trained_at,
      status: row.status,
      test_accuracy: row.test_accuracy,
      validation_accuracy: row.validation_accuracy,
      model_checksum: row.model_checksum,
      classes: row.classes ?? [],
      notes: row.notes ?? "",
    });
  }

  return [...byVersion.values()].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true }),
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}