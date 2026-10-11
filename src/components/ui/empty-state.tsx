import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The empty state.
 *
 * Every empty collection in the app renders through this component, and every
 * one of them says what is missing and what to do next. "No scans yet" is not a
 * failure state and is never dressed up as one.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-ink-300 bg-ink-50/60 text-center",
        compact ? "px-5 py-8" : "px-6 py-14",
        className,
      )}
    >
      {Icon ? (
        <span className="mb-3 rounded-full bg-white p-3 text-ink-400 ring-1 ring-ink-200">
          <Icon className="size-6" aria-hidden="true" />
        </span>
      ) : null}
      <p className="text-sm font-semibold text-ink-800">{title}</p>
      {description ? (
        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-600">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Skeleton placeholder. Announced as busy, never as content. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("skeleton", className)} />;
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/**
 * A definition row for key/value metadata, e.g. checksums and IDs.
 */
export function DetailRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-100 py-2 last:border-b-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className={cn("min-w-0 break-all text-right text-sm text-ink-800", mono && "font-mono text-xs")}>
        {children}
      </dd>
    </div>
  );
}