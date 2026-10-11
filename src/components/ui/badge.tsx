import { cn } from "@/lib/cn";
import type { ComponentProps, ReactNode } from "react";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700 ring-ink-200",
  brand: "bg-brand-50 text-brand-800 ring-brand-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-red-50 text-red-800 ring-red-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
};

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: Tone;
  icon?: ReactNode;
}

export function Badge({ className, tone = "neutral", icon, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * The badge for a health verdict.
 *
 * `null` status means the scan was never analysed (for example, it was rejected
 * by the quality gate). That is shown as "Not analysed", never as "Healthy".
 */
export function StatusBadge({
  status,
  state,
  className,
}: {
  status: "healthy" | "diseased" | null | undefined;
  state?: string;
  className?: string;
}) {
  if (state === "rejected_quality" || status === null || status === undefined) {
    return (
      <Badge tone="warning" className={className}>
        Not analysed
      </Badge>
    );
  }
  return status === "healthy" ? (
    <Badge tone="success" className={className}>
      Healthy
    </Badge>
  ) : (
    <Badge tone="danger" className={className}>
      Diseased
    </Badge>
  );
}

/**
 * Renders "Not available" for an unmeasured value.
 *
 * Kept as a component so the fallback is impossible to bypass: every optional
 * metric in the app routes through it.
 */
export function NotAvailable({ className, label = "Not available" }: { className?: string; label?: string }) {
  return (
    <span className={cn("text-ink-400 italic", className)} title="This value was not measured.">
      {label}
    </span>
  );
}