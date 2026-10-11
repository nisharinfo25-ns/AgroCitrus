/**
 * Per-user dashboard aggregates.
 *
 * Every query is scoped by `user_id = <caller>` and executed with the
 * RLS-scoped client, so the database enforces the boundary a second time even
 * though the query already filters.
 *
 * When a user has no scans the API returns zeros and `healthy_percentage: null`
 * rather than a fabricated 0% or 100% success rate.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { serverLog } from "@/lib/server";
import type { DashboardStats, Scan } from "@/types";

type ScopedClient = SupabaseClient<any>;

const EMPTY: DashboardStats = {
  total_scans: 0,
  healthy_results: 0,
  diseased_results: 0,
  low_confidence_results: 0,
  scans_last_30_days: 0,
  healthy_percentage: null,
  favourite_disease: null,
  recent_scans: [],
  by_class: [],
  by_input_type: [],
  trend: [],
};

export async function getDashboardStats(supabase: ScopedClient, userId: string): Promise<DashboardStats> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [totals, recent, byClass, byInputType, trendResult] = await Promise.all([
    supabase
      .from("scans")
      .select("status, is_low_confidence, created_at", { count: "exact" })
      .limit(10_000),
    supabase
      .from("scans")
      .select(
        "id, image_path, heatmap_path, explanation_path, input_type, input_type_confidence, predicted_class, predicted_class_display, confidence, status, prediction_state, is_low_confidence, severity, model_version, model_name, dataset_version, latency_ms, error_code, created_at, probabilities, part_probabilities, quality_metrics, explanation_note, processed_path, user_id",
      )
      .order("created_at", { ascending: false })
      .limit(5),
    supabase.from("scans").select("predicted_class, predicted_class_display").limit(10_000),
    supabase.from("scans").select("input_type").limit(10_000),
    supabase.from("scans").select("created_at").gte("created_at", thirtyDaysAgo).limit(10_000),
  ]);

  if (totals.error) {
    serverLog("dashboard", "totals query failed", totals.error);
    return { ...EMPTY, recent_scans: [] };
  }

  const rows = (totals.data ?? []) as Array<{ status: string | null; is_low_confidence: boolean; created_at: string }>;
  const totalScans = totals.count ?? rows.length;

  if (totalScans === 0) {
    return { ...EMPTY };
  }

  const healthy = rows.filter((r) => r.status === "healthy").length;
  const diseased = rows.filter((r) => r.status === "diseased").length;
  const lowConfidence = rows.filter((r) => r.is_low_confidence).length;
  const last30 = (trendResult.data ?? []).length;

  // Class frequency, excluding the healthy class so "favourite disease" means
  // an actual disease rather than "no disease".
  const classCounts = new Map<string, { class_name: string; count: number }>();
  for (const row of (byClass.data ?? []) as Array<{ predicted_class: string | null; predicted_class_display: string | null }>) {
    const key = row.predicted_class;
    if (!key || key === "healthy") continue;
    const label = row.predicted_class_display ?? key;
    const existing = classCounts.get(key);
    if (existing) existing.count += 1;
    else classCounts.set(key, { class_name: label, count: 1 });
  }
  const sortedClasses = [...classCounts.values()].sort((a, b) => b.count - a.count);

  const inputCounts = new Map<string, number>();
  for (const row of (byInputType.data ?? []) as Array<{ input_type: string | null }>) {
    if (!row.input_type) continue;
    inputCounts.set(row.input_type, (inputCounts.get(row.input_type) ?? 0) + 1);
  }

  // 14-day daily histogram for the dashboard chart.
  const days: Array<{ date: string; count: number }> = [];
  const countsByDay = new Map<string, number>();
  for (const row of (trendResult.data ?? []) as Array<{ created_at: string }>) {
    const day = row.created_at.slice(0, 10);
    countsByDay.set(day, (countsByDay.get(day) ?? 0) + 1);
  }
  for (let i = 13; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    days.push({ date, count: countsByDay.get(date) ?? 0 });
  }

  return {
    total_scans: totalScans,
    healthy_results: healthy,
    diseased_results: diseased,
    low_confidence_results: lowConfidence,
    scans_last_30_days: last30,
    // Computed from real rows; null only when there is nothing to divide.
    healthy_percentage: totalScans > 0 ? Number(((healthy / totalScans) * 100).toFixed(1)) : null,
    favourite_disease: sortedClasses[0] ?? null,
    recent_scans: (recent.data ?? []) as unknown as Scan[],
    by_class: sortedClasses,
    by_input_type: [...inputCounts.entries()].map(([input_type, count]) => ({ input_type, count })),
    trend: days,
  };
}
