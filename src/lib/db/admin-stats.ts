import "server-only";

/**
 * Admin system statistics.
 *
 * Lives here rather than in the route handler so the admin dashboard (a server
 * component) and `GET /api/admin/stats` read the same numbers. Two copies of
 * this aggregation would inevitably disagree, and an admin comparing the page
 * with the API would have no way to tell which was right.
 *
 * Every figure is measured. Where something cannot be measured the value is
 * `null` and the UI renders "Not available" - in particular
 * `healthy_percentage` is null (not 0) when there are no scans at all.
 */

import { isAdminConfigured, createAdminClient } from "@/lib/supabase/client";
import { execCliStatus } from "@/lib/ml/cli";
import { BUCKETS } from "@/lib/env";
import { serverLog } from "@/lib/server";
import type { ScopedClient } from "@/lib/db/scans";
import type { ModelVersion } from "@/types";

export interface AdminStats {
  users: { total: number; admins: number; active_7d: number };
  scans: {
    total: number;
    last_24h: number;
    last_7d: number;
    low_confidence: number;
    rejected_quality: number;
    healthy_percentage: number | null;
    by_class: { class_name: string; count: number }[];
    by_input_type: { input_type: string; count: number }[];
    by_model: { model_version: string; count: number }[];
  };
  system: {
    supabase: { connected: boolean; message: string };
    storage: { configured: boolean; buckets: Record<string, { accessible: boolean; error?: string }> };
    python: { available: boolean; version: string | null; message: string };
    dataset: { available: boolean; message: string; image_count: number | null };
    model: {
      configured: boolean;
      version: string | null;
      test_accuracy: number | null;
      validation_accuracy: number | null;
      message: string;
    };
  };
}

/**
 * Aggregate system statistics.
 *
 * `supabase` is the caller's RLS-scoped client, so user and scan counts respect
 * the admin policy. Storage and Python probes use the service client because
 * they need to see every bucket.
 */
export async function getAdminStats(supabase: ScopedClient): Promise<AdminStats> {
  const admin = createAdminClient();

const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
const oneDayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();

const [
  userCount,
  adminCount,
  activeProfiles,
  scanCount,
  recent7,
  recent24,
  lowConfidence,
  rejected,
  statusRows,
  classRows,
  inputRows,
  modelRows,
  datasetRow,
  modelRow,
] = await Promise.all([
  supabase.from("profiles").select("id", { count: "exact", head: true }),
  supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin"),
  // "Active" is defined as having signed in within 7 days. Supabase stores
  // the last sign-in only if the auth session is queried, so this uses the
  // scan activity a user has actually generated rather than a guessed field.
  supabase.from("scans").select("user_id").gte("created_at", sevenDaysAgo).limit(10_000),
  supabase.from("scans").select("id", { count: "exact", head: true }),
  supabase.from("scans").select("id").gte("created_at", sevenDaysAgo).limit(10_000),
  supabase.from("scans").select("id").gte("created_at", oneDayAgo).limit(10_000),
  supabase.from("scans").select("id", { count: "exact", head: true }).eq("is_low_confidence", true),
  supabase.from("scans").select("id", { count: "exact", head: true }).eq("prediction_state", "rejected_quality"),
  supabase.from("scans").select("status").limit(20_000),
  supabase.from("scans").select("predicted_class, predicted_class_display").limit(20_000),
  supabase.from("scans").select("input_type").limit(20_000),
  supabase.from("scans").select("model_version").limit(20_000),
  supabase
    .from("dataset_metadata")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle(),
  supabase
    .from("model_versions")
    .select("*")
    .eq("status", "production")
    .order("promoted_at", { ascending: false })
    .limit(1)
    .maybeSingle(),
]);

// ---- Storage reachability (each bucket, individually) -------------- //
const buckets: AdminStats["system"]["storage"]["buckets"] = {};
if (isAdminConfigured()) {
  await Promise.all(
    Object.values(BUCKETS).map(async (bucket) => {
      try {
        const { error } = await admin.storage.from(bucket).list("", { limit: 1 });
        buckets[bucket] = error
          ? { accessible: false, error: error.message }
          : { accessible: true };
      } catch (error) {
        buckets[bucket] = {
          accessible: false,
          error: error instanceof Error ? error.message : "unknown error",
        };
      }
    }),
  );
}

// ---- Python runtime ------------------------------------------------ //
let python: AdminStats["system"]["python"] = {
  available: false,
  version: null,
  message: "Not checked.",
};
let datasetCli: Record<string, unknown> | null = null;
try {
  const { checkPython } = await import("@/lib/ml/client");
  const probe = await checkPython();
  python = { available: probe.available, version: probe.version ?? null, message: probe.message };
  datasetCli = (await execCliStatus(["dataset", "status"]).catch((error) => {
    serverLog("admin.stats", "dataset status unavailable", error);
    return null;
  })) as Record<string, unknown> | null;
} catch (error) {
  serverLog("admin.stats", "python probe failed", error);
}

const manifest = (datasetCli?.manifest ?? null) as { image_count?: number } | null;
const production = modelRow.data as ModelVersion | null;

// ---- Aggregates ---------------------------------------------------- //
const statuses = (statusRows.data ?? []) as Array<{ status: string | null }>;
const total = scanCount.count ?? 0;
const healthy = statuses.filter((r) => r.status === "healthy").length;

const tally = <T,>(rows: T[], key: (row: T) => string | null, skip?: (key: string) => boolean) => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    if (!k || skip?.(k)) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ class_name: name, count }))
    .sort((a, b) => b.count - a.count);
};

const byClass = tally(
  (classRows.data ?? []) as Array<{ predicted_class: string | null; predicted_class_display: string | null }>,
  (r) => r.predicted_class_display ?? r.predicted_class,
  (k) => k === "healthy" || k === "Not analysed",
).map((entry) => ({
  class_name: entry.class_name,
  count: entry.count,
}));

const body: AdminStats = {
  users: {
    total: userCount.count ?? 0,
    admins: adminCount.count ?? 0,
    active_7d: new Set((activeProfiles.data ?? []).map((r: { user_id: string }) => r.user_id)).size,
  },
  scans: {
    total,
    last_24h: recent24.data?.length ?? 0,
    last_7d: recent7.data?.length ?? 0,
    low_confidence: lowConfidence.count ?? 0,
    rejected_quality: rejected.count ?? 0,
    healthy_percentage: total > 0 ? Number(((healthy / total) * 100).toFixed(1)) : null,
    by_class: byClass,
    by_input_type: tally((inputRows.data ?? []) as Array<{ input_type: string | null }>, (r) => r.input_type).map(
      (e) => ({ input_type: e.class_name, count: e.count }),
    ),
    by_model: tally((modelRows.data ?? []) as Array<{ model_version: string | null }>, (r) => r.model_version).map(
      (e) => ({ model_version: e.class_name, count: e.count }),
    ),
  },
  system: {
    supabase: {
      connected: !datasetRow.error,
      message: datasetRow.error
        ? `PostgreSQL query failed: ${datasetRow.error.message}`
        : "Connected.",
    },
    storage: {
      configured: isAdminConfigured(),
      buckets: isAdminConfigured()
        ? buckets
        : { "citrus-dataset": { accessible: false, error: "SUPABASE_SERVICE_ROLE_KEY is not set." } },
    },
    python,
    dataset: {
      available: Boolean(datasetRow.data) || Boolean(manifest),
      image_count: datasetRow.data?.image_count ?? manifest?.image_count ?? null,
      message: datasetRow.data
        ? `Recorded in PostgreSQL as v${datasetRow.data.version} (${datasetRow.data.status}).`
        : manifest
          ? `Prepared locally only (${manifest.image_count ?? "?"} images). Run the sync step to record it in PostgreSQL.`
          : "Dataset setup required.",
    },
    model: {
      configured: Boolean(production),
      version: production?.version ?? null,
      test_accuracy: production?.test_accuracy ?? null,
      validation_accuracy: production?.validation_accuracy ?? null,
      message: production
        ? `Model ${production.version} is live.`
        : "Model is not configured.",
    },
  },
};
  return body;
}
