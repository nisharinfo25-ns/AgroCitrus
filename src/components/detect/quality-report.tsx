import { CameraOff, Check, X } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/cn";
import type { QualityMetrics } from "@/types";

/**
 * The image-quality gate report.
 *
 * The individual check values (sharpness, brightness, resolution) are real
 * measurements taken with OpenCV, so they are printed exactly. The `passed`
 * flag is the gate's own decision, and when it fails the reasons are shown
 * verbatim rather than summarised into a vague "bad image".
 */
export function QualityReport({ quality }: { quality: QualityMetrics | null | undefined }) {
  if (!quality) {
    return (
      <Alert tone="info" title="Quality checks were not run">
        The image was not measured before inference. This happens when a scan was saved without going through
        the upload pipeline.
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex items-start gap-3 rounded-[var(--radius-card)] border p-4 text-sm",
          quality.passed ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900",
        )}
      >
        <span className="mt-0.5 shrink-0">
          {quality.passed ? (
            <Check className="size-4 text-emerald-600" aria-hidden="true" />
          ) : (
            <CameraOff className="size-4 text-amber-600" aria-hidden="true" />
          )}
        </span>
        <div>
          <p className="font-semibold">
            {quality.passed
              ? "The image passed every quality check."
              : "The image did not pass the quality gate."}
          </p>
          {quality.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {quality.reasons.map((reason) => (
                <li key={reason} className="flex gap-2">
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-current opacity-60" />
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Measurement
          label="Sharpness"
          value={quality.sharpness}
          digits={1}
          hint="Variance of the Laplacian. Higher is sharper."
        />
        <Measurement
          label="Brightness"
          value={quality.brightness}
          digits={1}
          hint="Mean intensity, 0-255."
        />
        <Measurement label="Contrast" value={quality.contrast} digits={1} hint="Intensity standard deviation." />
        <Measurement
          label="Resolution"
          value={quality.megapixels}
          digits={2}
          unit=" MP"
          hint={`${quality.width} x ${quality.height} pixels`}
        />
      </dl>

      {quality.checks.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Individual checks</h4>
          <ul className="mt-2 divide-y divide-ink-100 rounded-lg border border-ink-200">
            {quality.checks.map((check) => (
              <li key={check.name} className="flex items-start gap-3 px-3 py-2.5">
                <span
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
                    check.passed ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700",
                  )}
                >
                  {check.passed ? (
                    <Check className="size-2.5" aria-hidden="true" />
                  ) : (
                    <X className="size-2.5" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium capitalize text-ink-900">{check.name}</p>
                  <p className="text-xs text-ink-500">
                    Measured {check.value} &middot; requires {check.threshold}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-600">{check.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Measurement({
  label,
  value,
  digits,
  unit = "",
  hint,
}: {
  label: string;
  value: number;
  digits: number;
  unit?: string;
  hint: string;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-1 font-mono text-sm font-semibold tabular-nums text-ink-900">
        {Number.isFinite(value) ? value.toFixed(digits) : "Not available"}
        {unit}
      </dd>
      <p className="mt-0.5 text-xs text-ink-500">{hint}</p>
    </div>
  );
}
