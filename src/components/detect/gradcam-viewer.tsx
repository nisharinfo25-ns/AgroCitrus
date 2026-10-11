"use client";

import { useState } from "react";
import { Eye, Info, Layers } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/cn";
import type { GradCamPayload } from "@/types";

/**
 * The explanation viewer.
 *
 * Three states, each with its own message:
 *   - a Grad-CAM image exists  -> show it beside the original;
 *   - the pipeline ran but produced none -> say why, don't fake a placeholder;
 *   - no explanation was attempted -> say the feature was not run.
 *
 * A blurred gradient box with "explanation unavailable" is never acceptable:
 * the user would reasonably read it as "the model found nothing here".
 */
export function GradCamViewer({
  originalUrl,
  gradcam,
  className,
}: {
  originalUrl: string | null;
  gradcam: GradCamPayload | null;
  className?: string;
}) {
  const [view, setView] = useState<"overlay" | "heatmap">("overlay");
  const [showOriginal, setShowOriginal] = useState(true);

  if (!gradcam) {
    return (
      <Alert tone="info" title="No explanation was generated for this scan" className={className}>
        Grad-CAM was not run for this prediction. Re-run the scan with explanations enabled, or check the
        server logs if you expected one.
      </Alert>
    );
  }

  const heatmapUrl = gradcam.overlay_url ?? gradcam.heatmap_path;
  const hasImage = Boolean(heatmapUrl);

  return (
    <div className={cn("space-y-4", className)}>
      {hasImage ? (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Explanation view"
              className="inline-flex rounded-lg border border-ink-300 bg-white p-0.5"
            >
              {(
                [
                  { key: "overlay", label: "Overlay" },
                  { key: "heatmap", label: "Heatmap" },
                ] as const
              ).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setView(option.key)}
                  aria-pressed={view === option.key}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    view === option.key
                      ? "bg-brand-700 text-white"
                      : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {originalUrl ? (
              <button
                type="button"
                onClick={() => setShowOriginal((value) => !value)}
                aria-pressed={showOriginal}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-600 hover:text-brand-700"
              >
                <Eye className="size-3.5" aria-hidden="true" />
                {showOriginal ? "Hide" : "Show"} the original
              </button>
            ) : null}
          </div>

          <div className={cn("grid gap-3", showOriginal && originalUrl ? "sm:grid-cols-2" : "grid-cols-1")}>
            {showOriginal && originalUrl ? (
              <figure className="space-y-2">
                <img
                  src={originalUrl}
                  alt="The image that was submitted for analysis"
                  className="aspect-square w-full rounded-lg border border-ink-200 object-cover"
                />
                <figcaption className="text-center text-xs text-ink-500">Original</figcaption>
              </figure>
            ) : null}

            <figure className="space-y-2">
              <img
                src={view === "overlay" ? (heatmapUrl as string) : (gradcam.heatmap_url ?? (heatmapUrl as string))}
                alt={
                  view === "overlay"
                    ? "The submitted image with the regions that most influenced the prediction highlighted"
                    : "The raw Grad-CAM activation heatmap, where warmer colours contributed more to the prediction"
                }
                className="aspect-square w-full rounded-lg border border-ink-200 object-cover"
              />
              <figcaption className="text-center text-xs text-ink-500">
                {view === "overlay" ? "Grad-CAM overlay" : "Activation heatmap"}
              </figcaption>
            </figure>
          </div>

          {gradcam.target_layer ? (
            <p className="mt-3 text-xs text-ink-500">
              Computed from the <code className="font-mono">{gradcam.target_layer}</code> convolutional layer
              against the predicted class.
            </p>
          ) : null}
        </div>
      ) : (
        <Alert tone="warning" title="The explanation image is missing" role="status">
          {gradcam.error ??
            "Grad-CAM ran but produced no image. This usually means the target layer produced no usable activations for this input."}
        </Alert>
      )}

      {gradcam.summary ? (
        <p className="flex gap-2 text-sm leading-relaxed text-ink-700">
          <Layers className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden="true" />
          {gradcam.summary}
        </p>
      ) : null}

      {gradcam.regions && gradcam.regions.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Highlighted regions</h4>
          <ul className="mt-2 space-y-1.5">
            {gradcam.regions.map((region) => (
              <li key={region} className="flex gap-2 text-sm text-ink-700">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" />
                {region}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="flex gap-2 rounded-lg bg-ink-50 p-3 text-xs leading-relaxed text-ink-600">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {gradcam.disclaimer ??
          "Grad-CAM shows which regions pushed the score up, not a causal proof of disease. A highlighted area is a place to look, not a diagnosis."}
      </p>
    </div>
  );
}
