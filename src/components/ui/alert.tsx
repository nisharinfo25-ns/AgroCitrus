import { cn } from "@/lib/cn";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, { wrapper: string; icon: ReactNode }> = {
  info: {
    wrapper: "border-sky-200 bg-sky-50 text-sky-900",
    icon: <Info className="size-4 text-sky-600" aria-hidden="true" />,
  },
  success: {
    wrapper: "border-emerald-200 bg-emerald-50 text-emerald-900",
    icon: <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />,
  },
  warning: {
    wrapper: "border-amber-200 bg-amber-50 text-amber-900",
    icon: <AlertTriangle className="size-4 text-amber-600" aria-hidden="true" />,
  },
  danger: {
    wrapper: "border-red-200 bg-red-50 text-red-900",
    icon: <XCircle className="size-4 text-red-600" aria-hidden="true" />,
  },
};

/**
 * `title` is omitted from the div attributes: the DOM `title` attribute is a
 * string tooltip, and this component's `title` is a visible heading that
 * accepts arbitrary nodes. Inheriting both would make every call site a type
 * error and invite the wrong one.
 */
export interface AlertProps extends Omit<ComponentProps<"div">, "title"> {
  tone?: Tone;
  title?: ReactNode;
  /** Announced immediately - use for errors returned by an action. */
  role?: "alert" | "status";
}

/**
 * An inline notice.
 *
 * Errors use `role="alert"` so screen readers interrupt with the message; static
 * explanatory notes use `role="status"` and wait for a pause.
 */
export function Alert({ tone = "info", title, role, className, children, ...props }: AlertProps) {
  const config = TONES[tone];
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cn("flex gap-3 rounded-[var(--radius-card)] border p-4 text-sm", config.wrapper, className)}
      {...props}
    >
      <span className="mt-0.5 shrink-0">{config.icon}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && "mt-1", "leading-relaxed")}>{children}</div> : null}
      </div>
    </div>
  );
}

/** A short, prominent banner for a whole page (setup errors, forbidden). */
export function PageNotice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Alert tone={tone} title={title} className={cn("items-center", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {action}
      </div>
    </Alert>
  );
}