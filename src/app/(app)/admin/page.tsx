import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, BookOpen, Cpu, Database, Server, Users } from "lucide-react";

import { AdminActions } from "@/components/admin/admin-actions";
import { ModelVersionTable } from "@/components/admin/model-version-table";
import { PageNotice } from "@/components/ui/alert";
import { Badge, NotAvailable } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailRow } from "@/components/ui/empty-state";
import { requireAdmin } from "@/lib/auth";
import { getAdminStats, type AdminStats } from "@/lib/db/admin-stats";
import { APP_CONFIG, BUCKETS } from "@/lib/env";
import { shortChecksum } from "@/lib/format";
import { isAdminConfigured } from "@/lib/supabase/client";
import type { DatasetStatusResponse, ModelStatusResponse } from "@/types";

export const metadata: Metadata = {
  title: "Admin",
  description: "System status, dataset and model management.",
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Authorisation is server-side and role-based. The redirect happens before
  // any data is read, so a non-admin never causes a query to run.
  const { supabase, role } = await requireAdmin();
  if (role !== "admin") redirect("/dashboard");

  const adminConfigured = isAdminConfigured();

  const [{ data: modelStatus }, { data: datasetStatus }, stats] = await Promise.all([
    supabase
      .from("model_versions")
      .select(
        "id, version, model_name, model_architecture, model_checksum, classes, test_accuracy, validation_accuracy, trained_at, status, severity_support, notes, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("dataset_metadata")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Statistics are supporting detail, not the page. A failure here must not
    // hide the dataset and model panels an admin needs in order to fix it.
    getAdminStats(supabase).catch(() => null),
  ]);

  const versions = (modelStatus ?? []).map(toVersionSummary);
  const production = versions.find((entry) => entry.status === "production") ?? null;

  const datasetReady = Boolean(datasetStatus?.status === "ready");
  const modelDeployed = Boolean(production);

  const datasetView: DatasetStatusResponse["dataset"] = datasetStatus ?? null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Admin</h1>
          <p className="mt-2 text-sm text-ink-600">
            System state, dataset provenance and model deployment.
          </p>
        </div>
        <nav className="flex flex-wrap gap-2">
          <AdminLink href="/admin/users" icon={Users} label="Users" />
          <AdminLink href="/admin/diseases" icon={BookOpen} label="Disease content" />
        </nav>
      </header>

      {!adminConfigured ? (
        <PageNotice tone="warning" title="Admin actions are unavailable">
          <code className="font-mono text-xs">SUPABASE_SERVICE_ROLE_KEY</code> is not set, so dataset
          downloads, model training and model activation are disabled. The read-only status below still works.
          Admin endpoints fail closed without the key rather than running unauthenticated &mdash; that is the
          intended behaviour, not a misconfiguration to work around.
        </PageNotice>
      ) : null}

      {/* ---------------- System ---------------- */}
      <Card>
        <CardHeader
          title="System"
          description="Live state of every dependency."
          action={<Server className="size-4 text-ink-400" aria-hidden="true" />}
        />
        {stats ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatusTile
              label="Supabase"
              ok={stats.system.supabase.connected}
              detail={stats.system.supabase.message}
            />
            <StatusTile
              label="Storage"
              ok={stats.system.storage.configured}
              detail={
                stats.system.storage.configured
                  ? `${Object.keys(stats.system.storage.buckets).length} private buckets configured.`
                  : "Service role key is not set."
              }
            />
            <StatusTile
              label="Python runtime"
              ok={stats.system.python.available}
              detail={stats.system.python.version ?? stats.system.python.message}
            />
            <StatusTile
              label="Production model"
              ok={stats.system.model.configured}
              detail={stats.system.model.version ? `Serving ${stats.system.model.version}` : stats.system.model.message}
            />
          </div>
        ) : (
          <PageNotice tone="info" title="System statistics are unavailable">
            The aggregate queries did not complete, so the usage figures below are omitted rather than shown as
            zero. Everything else on this page is unaffected. Check the server logs for the underlying error.
          </PageNotice>
        )}
      </Card>

      {/* ---------------- Usage ---------------- */}
      {stats ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Users" value={stats.users.total} hint={`${stats.users.active_7d} active this week`} />
          <Tile label="Scans" value={stats.scans.total} hint={`${stats.scans.last_7d} in the last 7 days`} />
          <Tile
            label="Low confidence"
            value={stats.scans.low_confidence}
            tone={stats.scans.low_confidence > 0 ? "warning" : "neutral"}
            hint="Below the model threshold"
          />
          <Tile
            label="Rejected by quality gate"
            value={stats.scans.rejected_quality}
            hint="Never reached the model"
          />
        </div>
      ) : null}

      {/* ---------------- Dataset ---------------- */}
      <Card>
        <CardHeader
          title="Dataset"
          description="Provenance and verification of the training data."
          action={
            <Badge
              tone={datasetReady ? "success" : "warning"}
              icon={<Database className="size-3" aria-hidden="true" />}
            >
              {datasetView ? datasetView.status : "Not recorded"}
            </Badge>
          }
        />
        {datasetView ? (
          <dl>
            <DetailRow label="Name">{datasetView.dataset_name}</DetailRow>
            <DetailRow label="Version" mono>
              {datasetView.version}
            </DetailRow>
            <DetailRow label="Images">
              {typeof datasetView.image_count === "number" ? datasetView.image_count.toLocaleString() : <NotAvailable />}
            </DetailRow>
            <DetailRow label="Classes">
              {typeof datasetView.class_count === "number" ? String(datasetView.class_count) : <NotAvailable />}
            </DetailRow>
            <DetailRow label="Parts">{datasetView.parts?.length ? datasetView.parts.join(", ") : <NotAvailable />}</DetailRow>
            <DetailRow label="Licence">{datasetView.license ?? <NotAvailable />}</DetailRow>
            <DetailRow label="DOI" mono>
              {datasetView.doi ?? <NotAvailable />}
            </DetailRow>
            <DetailRow label="Attribution">{datasetView.attribution ?? <NotAvailable />}</DetailRow>
            <DetailRow label="Storage path" mono>
              {datasetView.storage_path ?? <NotAvailable />}
            </DetailRow>
            <DetailRow label="Content checksum" mono>
              {datasetView.checksum ? shortChecksum(datasetView.checksum, 20) : <NotAvailable />}
            </DetailRow>
            <DetailRow label="Downloaded">{datasetView.downloaded_at ?? <NotAvailable />}</DetailRow>
            {datasetView.counts_by_part && Object.keys(datasetView.counts_by_part).length > 0 ? (
              <DetailRow label="Per part">
                <span className="text-xs">
                  {Object.entries(datasetView.counts_by_part).map(([part, counts]) => (
                    <span key={part} className="block">
                      <span className="font-medium text-ink-700">{part}:</span>{" "}
                      {Object.entries(counts)
                        .map(([name, n]) => `${name} ${n}`)
                        .join(", ")}
                    </span>
                  ))}
                </span>
              </DetailRow>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm leading-relaxed text-ink-600">
            No dataset has been recorded. Until one is, no result produced by this instance can state which
            images it was trained on.
          </p>
        )}
      </Card>

      {/* ---------------- Actions ---------------- */}
      <Card>
        <CardHeader
          title="Operations"
          description="Long-running jobs. These are not automatic."
        />
        <AdminActions datasetReady={datasetReady} modelDeployed={modelDeployed} />
      </Card>

      {/* ---------------- Versions ---------------- */}
      <Card>
        <CardHeader
          title="Model versions"
          description="Everything trained, and which one is live."
          action={<Cpu className="size-4 text-ink-400" aria-hidden="true" />}
        />
        <ModelVersionTable
          versions={versions}
          currentVersion={production?.version ?? null}
          canActivate={adminConfigured}
        />
      </Card>

      {/* ---------------- Configuration ---------------- */}
      <Card>
        <CardHeader title="Configuration" description="Server-side values, read from the environment." />
        <dl>
          <DetailRow label="Confidence threshold">
            <span className="font-mono text-xs">{APP_CONFIG.minConfidence}</span>
          </DetailRow>
          <DetailRow label="Service role key">
            {adminConfigured ? "Configured" : "Not set"}
          </DetailRow>
          <DetailRow label="Buckets" mono>
            {Object.values(BUCKETS).join(", ")}
          </DetailRow>
        </dl>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function AdminLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: typeof Users;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-300 bg-white px-3 text-sm font-medium text-ink-800 transition-colors hover:bg-ink-50"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </Link>
  );
}

function StatusTile({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-600">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${ok ? "text-emerald-800" : "text-amber-800"}`}>
        {ok ? "Available" : "Unavailable"}
      </p>
      <p className="mt-0.5 break-words text-xs text-ink-600">{detail}</p>
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
  tone?: "neutral" | "warning";
}) {
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p
        className={`mt-1.5 text-2xl font-bold tabular-nums ${
          tone === "warning" ? "text-amber-700" : "text-ink-900"
        }`}
      >
        {value.toLocaleString()}
      </p>
      <p className="mt-0.5 text-xs text-ink-500">{hint}</p>
    </div>
  );
}

function toVersionSummary(row: Record<string, unknown>): ModelStatusResponse["versions"][number] {
  return {
    version: String(row.version ?? ""),
    trained_at: typeof row.trained_at === "string" ? row.trained_at : null,
    status: (row.status as ModelStatusResponse["versions"][number]["status"]) ?? "candidate",
    test_accuracy: typeof row.test_accuracy === "number" ? row.test_accuracy : null,
    validation_accuracy: typeof row.validation_accuracy === "number" ? row.validation_accuracy : null,
    model_checksum: typeof row.model_checksum === "string" ? row.model_checksum : null,
    classes: Array.isArray(row.classes) ? (row.classes as string[]) : [],
    notes: typeof row.notes === "string" ? row.notes : "",
  };
}
