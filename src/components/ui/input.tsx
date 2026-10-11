import { cn } from "@/lib/cn";
import type { ComponentProps, ReactNode } from "react";

export interface FieldProps {
  label: string;
  htmlFor: string;
  /** Shown under the field and announced with it. */
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-800">
        {label}
        {required ? (
          <span className="ml-1 text-red-600" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-ink-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:bg-ink-100 aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-500/20";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(CONTROL, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(CONTROL, "min-h-24 resize-y", className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(CONTROL, "h-10 pr-8", className)} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 rounded border-ink-300 text-brand-700 focus:ring-2 focus:ring-brand-500/30",
        className,
      )}
      {...props}
    />
  );
}

/** A list of checkboxes rendered as toggle cards. */
export function CheckboxCard({
  id,
  name,
  value,
  defaultChecked,
  title,
  description,
}: {
  id: string;
  name: string;
  value: string;
  defaultChecked?: boolean;
  title: string;
  description?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 bg-white p-3 transition-colors hover:bg-ink-50 has-checked:border-brand-400 has-checked:bg-brand-50"
    >
      <input
        id={id}
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 shrink-0 rounded border-ink-300 text-brand-700 focus:ring-2 focus:ring-brand-500/30"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-900">{title}</span>
        {description ? <span className="mt-0.5 block text-xs text-ink-600">{description}</span> : null}
      </span>
    </label>
  );
}