import type { Metadata } from "next";
import Link from "next/link";
import { Camera, Plus, TriangleAlert, TrendingUp } from "lucide-react";

import { ClassDistributionChart, InputTypeChart, PercentStat, ScanTrendChart } from "@/components/dashboard/charts";
import { ScanCard } from "@/components/scan-card";
import { PageNotice } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireUser } from "@/lib/auth";
import { getDashboardStats } from "@/lib/db/stats";
import { signScanImagesSafe } from "@/lib/db/scans";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/client";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your scan totals, trends and recent results.",
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { supabase, user } = await requireUser();
  const stats = await getDashboardStats(supabase, user.id);

  // Signed image URLs are optional decoration, and minting them needs the
  // service-role key. `createAdminClient()` THROWS when that key is absent, so
  // it is only constructed after the check - calling it inline here used to
  // abort the whole render and leave a signed-in user staring at a blank
  // dashboard. Without the key the page renders fully, just without thumbnails.
  const admin = isAdminConfigured() ? createAdminClient() : null;
  const recentWithUrls = await Promise.all(
    stats.recent_scans.slice(0, 4).map(async (scan) => ({
      scan,
      urls: await signScanImagesSafe(admin, scan),
    })),
  );

  const hasScans = stats.total_scans > 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Dashboard</h1>
          <p className="mt-2 text-sm text-ink-600">
            {hasScans
              ? "A summary of everything you have analysed."
              : "Nothing analysed yet. Your results and trends will build up here."}
          </p>
        </div>
        <Link
          href="/detect"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800"
        >
          <Plus className="size-4" aria-hidden="true" />
          New scan
        </Link>
      </header>

      {/* ---------------- Totals ---------------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Total scans" value={stats.total_scans} hint="All time" />
        <Tile label="Last 30 days" value={stats.scans_last_30_days} hint="Recent activity" />
        <Tile label="Diseased results" value={stats.diseased_results} hint="Classified as a disease" tone="danger" />
        <Tile
          label="Healthy results"
          value={stats.healthy_results}
          hint="No disease detected"
          tone="positive"
        />
      </div>

      {stats.low_confidence_results > 0 ? (
        <PageNotice tone="warning" title={`${stats.low_confidence_results} low-confidence result${stats.low_confidence_results === 1 ? "" : "s"}`}>
          These scans fell below the model&apos;s confidence threshold. They are still saved, but the label may
          be wrong &mdash; check the Grad-CAM overlay and symptoms before acting on them.{" "}
          <Link href="/scans?low=1" className="font-medium underline">
            Review them
          </Link>
          .
        </PageNotice>
      ) : null}

      {/* ---------------- Charts ---------------- */}
      {hasScans ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Scans over the last 30 days"
              description="Counted from your scan records, one entry per upload."
            />
            <ScanTrendChart trend={stats.trend} />
          </Card>

          <Card>
            <CardHeader
              title="Diseases detected"
              description="Healthy results are excluded so the disease mix is readable."
            />
            <ClassDistributionChart data={stats.by_class} />
          </Card>

          <Card>
            <CardHeader title="Leaf vs fruit" description="As decided by the first classification stage." />
            <InputTypeChart data={stats.by_input_type} />
          </Card>

          <Card>
            <CardHeader title="Your results at a glance" />
            <div className="space-y-5">
              <PercentStat
                label="Healthy share of all scans"
                value={stats.healthy_percentage}
                tone="brand"
              />
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Most frequent prediction</p>
                {stats.favourite_disease ? (
                  <p className="mt-1 text-2xl font-bold text-ink-900">{stats.favourite_disease.class_name}</p>
                ) : (
                  <p className="mt-1 text-base italic text-ink-400">
                    No diseased prediction has been made yet.
                  </p>
                )}
                {stats.favourite_disease ? (
                  <p className="mt-0.5 text-xs text-ink-500">
                    Across {stats.favourite_disease.count}{" "}
                    {stats.favourite_disease.count === 1 ? "scan" : "scans"}.
                  </p>
                ) : null}
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <EmptyState
          icon={Camera}
          title="No scans yet"
          description="Upload a citrus leaf or fruit image and the dashboard will fill in with your totals, trends and detection history."
          action={
            <Link
              href="/detect"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800"
            >
              <Plus className="size-4" aria-hidden="true" />
              Analyse your first image
            </Link>
          }
        />
      )}

      {/* ---------------- Recent ---------------- */}
      {recentWithUrls.length > 0 ? (
        <section>
          <div className="mb-4 flex items-end justify-between gap-4">
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink-900">
              <TrendingUp className="size-4 text-ink-400" aria-hidden="true" />
              Recent scans
            </h2>
            <Link href="/scans" className="text-sm font-medium text-brand-700 hover:text-brand-800">
              View all
            </Link>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {recentWithUrls.map(({ scan, urls }) => (
              <ScanCard
                key={scan.id}
                scan={scan}
                imageUrl={urls.image_url}
                heatmapUrl={urls.heatmap_url}
                href={`/scans/${scan.id}`}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {stats.low_confidence_results > 0 ? (
        <PageNotice tone="info" title="About low confidence">
          A result is marked low confidence when the model&apos;s top class scored below the threshold configured
          for the deployed model. It is not a failure &mdash; it is the model telling you it is unsure, which is
          worth knowing.
        </PageNotice>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: number;
  hint: string;
  tone?: "neutral" | "positive" | "danger";
}) {
  const valueClass = {
    neutral: "text-ink-900",
    positive: "text-brand-700",
    danger: "text-red-700",
  }[tone];

  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${valueClass}`}>
        {value.toLocaleString()}
      </p>
      <p className="mt-1 flex items-center gap-1 text-xs text-ink-500">
        {tone === "danger" && value > 0 ? <TriangleAlert className="size-3" aria-hidden="true" /> : null}
        {hint}
      </p>
    </div>
  );
}
