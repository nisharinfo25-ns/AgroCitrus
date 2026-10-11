import type { Metadata } from "next";
import Link from "next/link";
import { Cpu, HardDrive, LogOut, Server, ShieldCheck } from "lucide-react";

import { PageNotice } from "@/components/ui/alert";
import { Badge, NotAvailable } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailRow } from "@/components/ui/empty-state";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/auth";
import { BUCKETS } from "@/lib/env";
import { shortChecksum } from "@/lib/format";
import { isAdminConfigured } from "@/lib/supabase/client";

export const metadata: Metadata = {
  title: "Settings",
  description: "Deployed model, storage and session settings.",
};

export const dynamic = "force-dynamic";

/**
 * Settings.
 *
 * Every value here is *read-only* and read from the live deployment, never from
 * a form. There is deliberately no "confidence threshold" input: the threshold
 * is a property of the trained model, and letting a user change it would make
 * two users' results incomparable and unreproducible. The page explains that
 * rather than omitting it and leaving people wondering.
 */
export default async function SettingsPage() {
  const { supabase, profile, role } = await requireUser();

  const [{ data: model }, { data: dataset }] = await Promise.all([
    supabase
      .from("model_versions")
      .select("version, model_name, model_architecture, classes, test_accuracy, validation_accuracy, input_size, preprocessing_method, trained_at, severity_support, model_checksum, status")
      .eq("status", "production")
      .limit(1)
      .maybeSingle(),
    supabase
      .from("dataset_metadata")
      .select("dataset_name, version, source_url, license, doi, image_count, class_count, checksum, status")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Settings</h1>
        <p className="mt-2 text-sm text-ink-600">
          The state of this deployment. These values are read from the live system, not editable here.
        </p>
      </header>

      {/* ---------------- Model ---------------- */}
      <Card>
        <CardHeader
          title="Deployed model"
          description="The artefact currently answering predictions."
          action={
            model ? (
              <Badge tone="success" icon={<Cpu className="size-3" aria-hidden="true" />}>
                {model.version}
              </Badge>
            ) : (
              <Badge tone="warning">Not configured</Badge>
            )
          }
        />
        {model ? (
          <dl>
            <DetailRow label="Name">{model.model_name ?? <NotAvailable />}</DetailRow>
            <DetailRow label="Architecture">{model.model_architecture ?? <NotAvailable />}</DetailRow>
            <DetailRow label="Input size">
              {Array.isArray(model.input_size) ? model.input_size.join(" x ") : <NotAvailable />}
            </DetailRow>
            <DetailRow label="Preprocessing">{model.preprocessing_method ?? <NotAvailable />}</DetailRow>
            <DetailRow label="Classes">
              {model.classes?.length ? `${model.classes.length} (${model.classes.join(", ")})` : <NotAvailable />}
            </DetailRow>
            <DetailRow label="Test accuracy">
              {typeof model.test_accuracy === "number"
                ? `${(model.test_accuracy * 100).toFixed(1)}%`
                : "Not available"}
            </DetailRow>
            <DetailRow label="Validation accuracy">
              {typeof model.validation_accuracy === "number"
                ? `${(model.validation_accuracy * 100).toFixed(1)}%`
                : "Not available"}
            </DetailRow>
            <DetailRow label="Trained">{model.trained_at ?? <NotAvailable />}</DetailRow>
            <DetailRow label="Artefact checksum" mono>
              {shortChecksum(model.model_checksum, 16)}
            </DetailRow>
            <DetailRow label="Severity analysis">
              {(model.severity_support as { enabled?: boolean } | null)?.enabled
                ? "Available"
                : "Not available for this model"}
            </DetailRow>
          </dl>
        ) : (
          <p className="text-sm leading-relaxed text-ink-600">
            No production model is deployed, so images cannot be analysed. An administrator can train and
            activate one from the admin dashboard.
          </p>
        )}
      </Card>

      {/* ---------------- Confidence ---------------- */}
      <Card>
        <CardHeader title="Confidence threshold" description="Why this is not adjustable." />
        <p className="text-sm leading-relaxed text-ink-700">
          The minimum confidence a prediction must reach before it is presented without a low-confidence
          warning is a property of the trained model, not a personal preference. It is stored in the model
          configuration and read from there, so every result carries the same bar.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          If it were a per-user setting, two people comparing the same image could get different verdicts with
          no visible reason why, and a result could not be reproduced from the record. The current value is
          shown on the Detect page and on every scan result.
        </p>
        <Link href="/detect" className="mt-3 inline-block text-sm font-medium text-brand-700 hover:text-brand-800">
          See the threshold on the Detect page
        </Link>
      </Card>

      {/* ---------------- Dataset ---------------- */}
      <Card>
        <CardHeader
          title="Training data"
          description="Provenance of the images the model learned from."
          action={
            dataset ? (
              <Badge tone="neutral" icon={<HardDrive className="size-3" aria-hidden="true" />}>
                {dataset.version}
              </Badge>
            ) : null
          }
        />
        {dataset ? (
          <dl>
            <DetailRow label="Dataset">{dataset.dataset_name}</DetailRow>
            <DetailRow label="Status">{dataset.status}</DetailRow>
            <DetailRow label="Images">
              {typeof dataset.image_count === "number" ? dataset.image_count.toLocaleString() : <NotAvailable />}
            </DetailRow>
            <DetailRow label="Classes">
              {typeof dataset.class_count === "number" ? String(dataset.class_count) : <NotAvailable />}
            </DetailRow>
            <DetailRow label="Licence">{dataset.license ?? <NotAvailable />}</DetailRow>
            <DetailRow label="DOI" mono>
              {dataset.doi ?? <NotAvailable />}
            </DetailRow>
            <DetailRow label="Source">
              {dataset.source_url ? (
                <a
                  href={dataset.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-brand-700 hover:text-brand-800"
                >
                  Publisher page
                </a>
              ) : (
                <NotAvailable />
              )}
            </DetailRow>
            <DetailRow label="Content checksum" mono>
              {shortChecksum(dataset.checksum, 16)}
            </DetailRow>
          </dl>
        ) : (
          <p className="text-sm leading-relaxed text-ink-600">
            No dataset metadata has been recorded. Predictions, if any, will not state which data they came
            from &mdash; a real gap in reproducibility, not a cosmetic one.
          </p>
        )}
      </Card>

      {/* ---------------- Storage / server ---------------- */}
      <Card>
        <CardHeader
          title="Server configuration"
          description="Deployment state, as reported by the server."
          action={<Server className="size-4 text-ink-400" aria-hidden="true" />}
        />
        <dl>
          <DetailRow label="Service role key">
            {isAdminConfigured() ? (
              <span className="inline-flex items-center gap-1.5 text-brand-700">
                <ShieldCheck className="size-3" aria-hidden="true" />
                Configured
              </span>
            ) : (
              <span className="text-amber-700">Not set &mdash; admin features are disabled</span>
            )}
          </DetailRow>
          <DetailRow label="Image bucket" mono>
            {BUCKETS.scans}
          </DetailRow>
          <DetailRow label="Model bucket" mono>
            {BUCKETS.models}
          </DetailRow>
          <DetailRow label="Dataset bucket" mono>
            {BUCKETS.dataset}
          </DetailRow>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          All three buckets are private. Images are served through short-lived signed URLs, so a link copied
          from a scan result stops working shortly after the page is closed.
        </p>
      </Card>

      {!isAdminConfigured() ? (
        <PageNotice tone="info" title="Admin features are unavailable">
          <code className="font-mono text-xs">SUPABASE_SERVICE_ROLE_KEY</code> is not set on this server, so
          dataset management, model training and user administration are disabled. Everything else works
          normally. This is the safe default: admin endpoints fail closed rather than running unauthenticated.
        </PageNotice>
      ) : null}

      {/* ---------------- Session ---------------- */}
      <Card>
        <CardHeader title="Session" description="Signed in as" />
        <dl>
          <DetailRow label="Account">{profile.email}</DetailRow>
          <DetailRow label="Role">{role === "admin" ? "Administrator" : "User"}</DetailRow>
        </dl>
        <div className="mt-4 border-t border-ink-100 pt-4">
          <SignOutButton />
        </div>
      </Card>
    </div>
  );
}
