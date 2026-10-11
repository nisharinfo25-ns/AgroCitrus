import Link from "next/link";
import {
  ArrowRight,
  Ban,
  CircleAlert,
  Clock,
  Cpu,
  Download,
  Info,
  Leaf,
  ShieldQuestion,
  Sparkles,
} from "lucide-react";

import { GradCamViewer } from "@/components/detect/gradcam-viewer";
import { PartConfidence, ProbabilityBars } from "@/components/detect/probability-bars";
import { QualityReport } from "@/components/detect/quality-report";
import { Alert } from "@/components/ui/alert";
import { Badge, NotAvailable, StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailRow } from "@/components/ui/empty-state";
import { formatConfidence, formatDate } from "@/lib/format";
import type { GradCamPayload, ScanWithUrls, Severity } from "@/types";

/**
 * The full scan result.
 *
 * Used both immediately after a prediction and when re-reading a stored scan,
 * so the two views can never drift apart.
 *
 * Every conditional branch has an explicit fallback string. A missing field is
 * never rendered as a zero, a dash that looks like a measurement, or an empty
 * box that reads as "nothing was found".
 */
export function ResultPanel({ scan }: { scan: ScanWithUrls }) {
  const rejected = scan.prediction_state === "rejected_quality";
  const failed = scan.prediction_state === "failed";
  // A stage-1 abstention is persisted as `failed` + this code. It is shown with
  // its own wording because "analysis could not be completed" would suggest a
  // server fault, when in fact the pipeline deliberately declined to guess.
  const routingUncertain = failed && scan.error_code === "routing_uncertain";
  const lowConfidence = scan.is_low_confidence && !rejected && !failed;

  const severitySupported = false;

  return (
    <div className="space-y-5">
      {/* ---------------- Verdict ---------------- */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={scan.status} state={scan.prediction_state} />
              {scan.input_type ? (
                <Badge tone="neutral" icon={<Leaf className="size-3" aria-hidden="true" />}>
                  {scan.input_type === "leaf" ? "Leaf" : "Fruit"} image
                </Badge>
              ) : null}
              {lowConfidence ? (
                <Badge tone="warning" icon={<ShieldQuestion className="size-3" aria-hidden="true" />}>
                  Low confidence
                </Badge>
              ) : null}
            </div>

            <h2 className="mt-3 text-2xl font-bold tracking-tight text-ink-900">
              {rejected
                ? "Image rejected before analysis"
                : routingUncertain
                  ? "We could not tell if this is a leaf or a fruit"
                  : failed
                    ? "Analysis could not be completed"
                    : (scan.predicted_class_display ?? scan.predicted_class ?? "No class was predicted")}
            </h2>

            <p className="mt-1.5 text-sm text-ink-600">
              {rejected
                ? "The image did not meet the quality requirements, so the model was not run."
                : routingUncertain
                  ? "The first stage was not confident enough to choose a disease model, so it declined to guess. No disease prediction was made."
                  : failed
                    ? "The prediction pipeline reported an error. The technical detail is in the server logs."
                    : lowConfidence
                      ? "The model was not confident enough to treat this as a finding. Treat it as a suggestion and check the highlighted regions."
                      : "A confident classification from the deployed model."}
            </p>
          </div>

          {scan.confidence !== null && !rejected && !failed ? (
            <div className="shrink-0 text-right">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Prediction confidence</p>
              <p className="mt-1 font-mono text-3xl font-bold tabular-nums text-ink-900">
                {formatConfidence(scan.confidence)}
              </p>
            </div>
          ) : null}
        </div>

        {rejected && scan.quality_metrics ? (
          <Alert tone="warning" title="Why this image was rejected" className="mt-5">
            <ul className="space-y-1">
              {scan.quality_metrics.reasons.map((reason) => (
                <li key={reason}>&bull; {reason}</li>
              ))}
            </ul>
            <p className="mt-2">
              Try again with a sharper, better-lit photo taken closer to the leaf or fruit, and keep the subject
              in focus.
            </p>
          </Alert>
        ) : null}

        {routingUncertain ? (
          <Alert tone="warning" title="No disease prediction was made" className="mt-5">
            The leaf-vs-fruit router scored below its confidence threshold, so the pipeline stopped before running a
            disease model. Naming a disease here would mean attaching a diagnosis to a guess, and a Grad-CAM overlay
            would explain a class this image never supported. Resubmit a closer, better-lit photo of a single citrus
            leaf or fruit.
            {scan.part_probabilities.length > 0 ? (
              <span className="mt-2 block font-mono text-xs text-ink-600">
                {scan.part_probabilities
                  .map((p) => `${p.class_name}: ${formatConfidence(p.probability)}`)
                  .join(" · ")}
              </span>
            ) : null}
          </Alert>
        ) : null}

        {lowConfidence ? (
          <Alert tone="warning" title="This result is below the confidence threshold" className="mt-5">
            The model&apos;s best class scored below the configured minimum confidence, so the label may be wrong.
            Compare the Grad-CAM overlay with the symptoms in the disease guide before acting on it.
          </Alert>
        ) : null}
      </Card>

      {/* ---------------- Image + explanation ---------------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Submitted image" description="Stored privately and shown to you only." />
          {scan.image_url ? (
            <a href={scan.image_url} target="_blank" rel="noreferrer" className="block">
              <img
                src={scan.image_url}
                alt="The citrus image that was analysed"
                className="aspect-square w-full rounded-lg border border-ink-200 object-cover"
              />
            </a>
          ) : (
            <div className="grid aspect-square w-full place-items-center rounded-lg border border-dashed border-ink-300 bg-ink-50 text-sm text-ink-400">
              The image could not be loaded.
            </div>
          )}
          {scan.image_url ? (
            <a
              href={scan.image_url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800"
            >
              <Download className="size-3.5" aria-hidden="true" />
              Open full size
            </a>
          ) : null}
        </Card>

        <Card>
          <CardHeader
            title="What the model looked at"
            description="Regions that most influenced this prediction."
          />
          <GradCamViewer
            originalUrl={scan.image_url}
            gradcam={buildGradCam(scan)}
          />
        </Card>
      </div>

      {/* ---------------- Detail ---------------- */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Class probabilities" description="Every class the model scored." />
          <ProbabilityBars
            probabilities={scan.probabilities}
            highlight={scan.predicted_class_display ?? scan.predicted_class}
          />
        </Card>

        <Card>
          <CardHeader title="Input type" description="Leaf or fruit, decided by the first stage." />
          <PartConfidence
            probabilities={scan.part_probabilities}
            chosen={scan.input_type}
            confidence={scan.input_type_confidence}
          />
        </Card>

        <Card>
          <CardHeader title="Severity" description="How far the disease has progressed." />
          <SeverityPanel
            severity={scan.severity}
            supported={severitySupported}
            className={scan.predicted_class ? undefined : "text-ink-400"}
          />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Image quality"
          description="Measured before the model was allowed to answer."
          action={
            <Badge tone={scan.quality_metrics?.passed ? "success" : "warning"}>
              {scan.quality_metrics
                ? scan.quality_metrics.passed
                  ? "Passed"
                  : "Failed"
                : "Not checked"}
            </Badge>
          }
        />
        <QualityReport quality={scan.quality_metrics} />
      </Card>

      {/* ---------------- Provenance ---------------- */}
      <Card>
        <CardHeader
          title="How this result was produced"
          description="Everything needed to reproduce or dispute it."
        />
        <dl>
          <DetailRow label="Scanned" mono>
            {formatDate(scan.created_at, "time")}
          </DetailRow>
          <DetailRow label="Model">
            {scan.model_name ?? <NotAvailable />}
            {scan.model_version ? (
              <span className="ml-1.5 font-mono text-xs text-ink-500">({scan.model_version})</span>
            ) : null}
          </DetailRow>
          <DetailRow label="Dataset version">{scan.dataset_version ?? <NotAvailable />}</DetailRow>
          <DetailRow label="Input type">
            {scan.input_type ? (
              scan.input_type === "leaf" ? (
                "Leaf"
              ) : (
                "Fruit"
              )
            ) : (
              <NotAvailable label="Not determined" />
            )}
          </DetailRow>
          <DetailRow label="Routing confidence">
            {scan.input_type_confidence !== null ? (
              <span className="font-mono text-xs">{formatConfidence(scan.input_type_confidence)}</span>
            ) : (
              <NotAvailable label="Not measured" />
            )}
          </DetailRow>
          <DetailRow label="Prediction confidence">
            {scan.confidence !== null && !rejected && !failed ? (
              <span className="font-mono text-xs">{formatConfidence(scan.confidence)}</span>
            ) : (
              <NotAvailable label={rejected || failed ? "Not analysed" : "Not measured"} />
            )}
          </DetailRow>
          <DetailRow label="Inference time">
            {scan.latency_ms !== null ? (
              <span className="inline-flex items-center gap-1 font-mono text-xs">
                <Clock className="size-3" aria-hidden="true" />
                {scan.latency_ms} ms
              </span>
            ) : (
              <NotAvailable />
            )}
          </DetailRow>
          <DetailRow label="Scan reference" mono>
            {scan.id}
          </DetailRow>
          {scan.error_code ? (
            <DetailRow label="Error code" mono>
              <span className="inline-flex items-center gap-1 text-red-700">
                <Ban className="size-3" aria-hidden="true" />
                {scan.error_code}
              </span>
            </DetailRow>
          ) : null}
        </dl>
      </Card>

      {/* ---------------- Next steps ---------------- */}
      {scan.predicted_class && !rejected && !failed ? (
        <Card>
          <CardHeader title="What to do next" />
          <div className="space-y-3 text-sm leading-relaxed text-ink-700">
            <p>
              {scan.status === "healthy" ? (
                <>
                  The model found no evidence of the diseases it was trained on. That does not rule out
                  nutrient deficiency, water stress, root damage or insect pests &mdash; this model has no classes
                  for those conditions.
                </>
              ) : (
                <>
                  This looks most like <strong>{scan.predicted_class_display ?? scan.predicted_class}</strong>.
                  Check the highlighted regions against the documented symptoms before drawing a conclusion.
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {scan.predicted_class ? (
                <Link
                  href={`/diseases/${scan.predicted_class}`}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800"
                >
                  Read about this disease
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              ) : null}
              <Link
                href="/detect"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-ink-300 bg-white px-4 text-sm font-medium text-ink-800 transition-colors hover:bg-ink-50"
              >
                <Sparkles className="size-4" aria-hidden="true" />
                Scan another image
              </Link>
            </div>
          </div>
        </Card>
      ) : null}

      <p className="flex gap-2 text-xs leading-relaxed text-ink-500">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        CitrusGuard provides advisory information, not a laboratory diagnosis. Confirm any suspected disease with a
        local agricultural extension service before treating a crop.
      </p>
    </div>
  );
}

/**
 * Assemble the Grad-CAM payload for a stored scan.
 *
 * Returns `null` only when there is genuinely nothing to show - no artefact and
 * no written explanation. When an artefact exists but its signed URL could not
 * be minted, the path is still passed through so the viewer can report the
 * difference instead of silently showing nothing.
 */
function buildGradCam(scan: ScanWithUrls): GradCamPayload | null {
  const hasArtefact = Boolean(scan.heatmap_path || scan.overlay_url || scan.explanation_path);
  if (!hasArtefact && !scan.explanation_note) return null;

  return {
    heatmap_path: scan.heatmap_path,
    overlay_path: scan.explanation_path,
    heatmap_url: scan.heatmap_url,
    overlay_url: scan.overlay_url,
    summary: scan.explanation_note,
  };
}

/**
 * Severity.
 *
 * Rendered as an explicit unavailable state because the deployed model has no
 * severity head. The wording is a statement of fact about the model, not a
 * placeholder for missing data.
 */
export function SeverityPanel({
  severity,
  supported,
  className,
}: {
  severity: Severity | null;
  supported: boolean;
  className?: string;
}) {
  if (!supported) {
    return (
      <div className={className}>
        <p className="flex items-start gap-2 text-sm font-medium text-ink-600">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
          Severity analysis is not available for this model.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          The training dataset has no severity labels, so no severity classifier was trained. Guessing a stage
          of infection from a photograph would be misleading, so the feature is disabled rather than faked.
        </p>
      </div>
    );
  }

  if (!severity) {
    return <p className="text-sm italic text-ink-400">No severity was assigned to this scan.</p>;
  }

  return (
    <div>
      <Badge tone={severity === "severe" ? "danger" : severity === "moderate" ? "warning" : "info"}>{severity}</Badge>
      <p className="mt-2 text-sm text-ink-600">
        Assigned by the trained severity head. Confirm progression with a field inspection.
      </p>
    </div>
  );
}

/** A small inline note used on cards that show a machine-produced claim. */
export function ModelNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 text-xs leading-relaxed text-ink-500">
      <Cpu className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}
