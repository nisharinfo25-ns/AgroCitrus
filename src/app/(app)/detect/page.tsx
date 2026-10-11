import type { Metadata } from "next";
import { Camera, Cpu, Info } from "lucide-react";

import { ScanUploader } from "@/components/detect/scan-uploader";
import { PageNotice } from "@/components/ui/alert";
import { Badge, NotAvailable } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/db/schema";
import { APP_CONFIG } from "@/lib/env";
import { formatMetric } from "@/lib/format";

export const metadata: Metadata = {
  title: "Detect disease",
  description: "Upload a citrus fruit or leaf image for classification with a Grad-CAM explanation.",
};

export const dynamic = "force-dynamic";

/**
 * The detection page.
 *
 * When no production model is deployed, the upload form is replaced by a setup
 * notice. It is not disabled-and-hidden: the user is told exactly what is
 * missing and what state the system is in.
 */
export default async function DetectPage() {
  const { supabase } = await requireUser();

  const { data: model, error } = await supabase
    .from("model_versions")
    .select("version, model_architecture, classes, test_accuracy, validation_accuracy, input_size, preprocessing_method, trained_at, severity_support")
    .eq("status", "production")
    .limit(1)
    .maybeSingle();

  // Three distinct states, three distinct messages. "The table does not exist",
  // "the table is empty" and "the query genuinely failed" are different problems
  // with different fixes, so they must not share one error string.
  if (error && isMissingSchemaError(error)) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Detect disease</h1>
        <PageNotice tone="warning" title="Dataset setup required">
          <p>
            The database has no <code className="font-mono text-xs">model_versions</code> table yet, so no
            production model can be read and images cannot be analysed.
          </p>
          <p className="mt-2">
            This is a setup state, not a fault in your account or in your image. An administrator can apply the
            schema and activate a trained model; until then the disease guide is available.
          </p>
        </PageNotice>
      </div>
    );
  }

  if (error) {
    // A failed lookup is not the same as "no model". Say which one it was.
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Detect disease</h1>
        <PageNotice tone="danger" title="The model configuration could not be read">
          The database did not return the production model record. This is a server-side problem, not a problem
          with your image. Try again shortly; if it persists, an administrator needs to check the deployment.
        </PageNotice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Detect disease</h1>
          {model ? (
            <Badge tone="brand" icon={<Cpu className="size-3" aria-hidden="true" />}>
              {model.version}
            </Badge>
          ) : null}
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-600">
          Upload a photo of a single citrus leaf or fruit. The image is checked for quality, classified by a
          two-stage model, and explained with Grad-CAM.
        </p>
      </header>

      {model ? (
        <ScanUploader minConfidence={APP_CONFIG.minConfidence} />
      ) : (
        <PageNotice tone="warning" title="Model is not configured">
          <p>
            No production model has been deployed yet, so images cannot be analysed. This is a deployment state,
            not a fault in your setup.
          </p>
          <p className="mt-2">
            An administrator can train and activate a model from the admin dashboard. The disease guide is
            available in the meantime.
          </p>
        </PageNotice>
      )}

      {model ? (
        <Card>
          <CardHeader
            title="The model that will answer"
            description="Read from the production record in PostgreSQL, so it cannot drift from what is actually deployed."
          />
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Fact label="Version" value={model.version} />
            <Fact label="Architecture" value={model.model_architecture ?? null} />
            <Fact
              label="Test accuracy"
              value={
                typeof model.test_accuracy === "number"
                  ? formatMetric(model.test_accuracy)
                  : null
              }
            />
            <Fact
              label="Validation accuracy"
              value={
                typeof model.validation_accuracy === "number"
                  ? formatMetric(model.validation_accuracy)
                  : null
              }
            />
            <Fact
              label="Classes"
              value={model.classes?.length ? `${model.classes.length} classes` : null}
            />
            <Fact
              label="Input size"
              value={Array.isArray(model.input_size) ? model.input_size.join(" x ") : null}
            />
            <Fact label="Preprocessing" value={model.preprocessing_method ?? null} />
            <Fact
              label="Severity analysis"
              value={
                (model.severity_support as { enabled?: boolean } | null)?.enabled
                  ? "Available"
                  : "Not available"
              }
            />
          </dl>

          <p className="mt-4 flex gap-2 border-t border-ink-100 pt-3 text-xs leading-relaxed text-ink-500">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Test accuracy is measured on a held-out split that was never used for training or for choosing
            epochs. It is not a guarantee for your photographs &mdash; field images differ from dataset images in
            lighting, framing and camera.
          </p>
        </Card>
      ) : null}

      <div className="rounded-[var(--radius-card)] border border-ink-200 bg-white p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
          <Camera className="size-4 text-ink-400" aria-hidden="true" />
          How your image is handled
        </h2>
        <ul className="mt-2.5 space-y-1.5 text-sm leading-relaxed text-ink-700">
          <li>
            Your image is stored in a private bucket under your own user ID. Other users cannot reach it, and
            row-level security in PostgreSQL enforces that.
          </li>
          <li>
            The image, a processed copy and the explanation are kept so a result can be re-examined later. You
            can delete a scan at any time, which removes the row and the files.
          </li>
          <li>
            CitrusGuard records which model version and dataset version produced each result, so a prediction can
            always be traced back to the exact artefact that made it.
          </li>
        </ul>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-ink-900">
        {value ?? <NotAvailable label="Not available" />}
      </dd>
    </div>
  );
}
