import Link from "next/link";
import { CameraOff, Clock, Leaf, TriangleAlert } from "lucide-react";

import { Badge, NotAvailable, StatusBadge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatConfidence, formatDate } from "@/lib/format";
import type { Scan } from "@/types";

/**
 * One row in the scan history.
 *
 * The thumbnail is optional: a signed URL may have expired or failed to mint.
 * When that happens the tile renders an explicit placeholder rather than a
 * broken-image icon, and the row stays fully usable.
 */
export function ScanCard({
  scan,
  imageUrl,
  heatmapUrl,
  href,
}: {
  scan: Scan;
  imageUrl?: string | null;
  heatmapUrl?: string | null;
  href: string;
}) {
  const rejected = scan.prediction_state === "rejected_quality";
  const failed = scan.prediction_state === "failed";

  return (
    <li>
      <Link
        href={href}
        className="card-interactive group flex h-full flex-col overflow-hidden p-0 no-underline"
      >
        <div className="relative aspect-4/3 overflow-hidden bg-ink-100">
          {imageUrl ? (
            // Signed, short-lived URL from a private bucket. A plain <img> is
            // correct here: next/image would need to re-sign every request.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="grid size-full place-items-center text-ink-300">
              <CameraOff className="size-8" aria-hidden="true" />
            </div>
          )}

          {heatmapUrl && !rejected && !failed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/10 to-transparent" />
          ) : null}

          <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">
            <StatusBadge status={scan.status} state={scan.prediction_state} />
            {scan.is_low_confidence && !rejected ? (
              <Badge tone="warning" icon={<TriangleAlert className="size-3" aria-hidden="true" />}>
                Low
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex flex-1 flex-col p-4">
          <h3 className="truncate text-sm font-semibold text-ink-900">
            {rejected
              ? "Rejected before analysis"
              : failed
                ? "Analysis failed"
                : (scan.predicted_class_display ?? scan.predicted_class ?? "No class predicted")}
          </h3>

          <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-500">
            {scan.input_type ? (
              <>
                <Leaf className="size-3" aria-hidden="true" />
                {scan.input_type === "leaf" ? "Leaf" : "Fruit"}
              </>
            ) : (
              <span className="italic">Input type not determined</span>
            )}
            <span aria-hidden="true">&middot;</span>
            <Clock className="size-3" aria-hidden="true" />
            {formatDate(scan.created_at, "time")}
          </p>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-ink-100 pt-3">
            <span className="text-xs text-ink-500">Confidence</span>
            <span
              className={cn(
                "font-mono text-sm font-semibold tabular-nums",
                scan.is_low_confidence ? "text-amber-700" : "text-ink-900",
              )}
            >
              {rejected || failed ? <NotAvailable label="—" /> : formatConfidence(scan.confidence)}
            </span>
          </div>

          {scan.model_version ? (
            <p className="mt-1.5 truncate text-xs text-ink-400">
              Model <span className="font-mono">{scan.model_version}</span>
            </p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
