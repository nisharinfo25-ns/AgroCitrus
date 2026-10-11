import { cn } from "@/lib/cn";
import { formatConfidence } from "@/lib/format";
import type { Probability } from "@/types";

/**
 * The full class probability vector, sorted descending.
 *
 * Every probability that the model emitted is rendered, not just the top one -
 * hiding the runner-up is how a confident-looking wrong answer gets made.
 * `highlight` marks the predicted class.
 */
export function ProbabilityBars({
  probabilities,
  highlight,
  className,
  emptyLabel = "No probabilities were returned for this scan.",
}: {
  probabilities: Probability[] | null | undefined;
  highlight?: string | null;
  className?: string;
  emptyLabel?: string;
}) {
  if (!probabilities || probabilities.length === 0) {
    return <p className="text-sm italic text-ink-400">{emptyLabel}</p>;
  }

  const sorted = [...probabilities].sort((a, b) => b.probability - a.probability);

  return (
    <ul className={cn("space-y-2.5", className)}>
      {sorted.map((entry) => {
        const percent = Math.max(0, Math.min(1, entry.probability));
        const isTop = highlight ? entry.class_name === highlight : false;
        return (
          <li key={entry.class_name}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className={cn("truncate", isTop ? "font-semibold text-ink-900" : "text-ink-600")}>
                {entry.class_name}
                {isTop ? (
                  <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-800">
                    Top
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-ink-600">
                {formatConfidence(percent)}
              </span>
            </div>
            <div
              className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100"
              role="meter"
              aria-valuenow={Math.round(percent * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${entry.class_name} probability`}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500",
                  isTop ? "bg-brand-600" : "bg-ink-300",
                )}
                style={{ width: `${percent * 100}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Leaf-vs-Fruit routing stage.
 *
 * When the deployed bundle ships the trained router, these are its own
 * probabilities and `confidence` is its real top-1 score. When it does not, the
 * caller passes the legacy heuristic's normalised scores instead and the result
 * panel labels the source. Either way the number rendered is a measurement, not
 * a re-scaled disease confidence, and when the stage did not decide, this says
 * so rather than quietly picking one.
 */
export function PartConfidence({
  probabilities,
  chosen,
  confidence,
}: {
  probabilities: Probability[] | null | undefined;
  chosen: "leaf" | "fruit" | null;
  confidence: number | null;
}) {
  if (!chosen) {
    return (
      <p className="text-sm italic text-ink-400">
        The model did not confirm whether this is a leaf or a fruit, so no disease prediction applies.
      </p>
    );
  }

  const parts = probabilities ?? [];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink-600">Detected input type</span>
        <span className="text-sm font-semibold capitalize text-ink-900">{chosen}</span>
      </div>
      {confidence !== null ? (
        <div className="mt-2">
          <div className="flex items-baseline justify-between text-xs text-ink-500">
            <span>Routing confidence</span>
            <span className="font-mono tabular-nums">{formatConfidence(confidence)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${confidence * 100}%` }} />
          </div>
        </div>
      ) : null}
      {parts.length > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          {parts.map((p) => `${p.class_name}: ${formatConfidence(p.probability)}`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}