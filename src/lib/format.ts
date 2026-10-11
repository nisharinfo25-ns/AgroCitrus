/** Formatting helpers shared across the UI. */

const EMPTY_LABELS: Record<string, string> = {
  "not available": "Not available",
};

/**
 * Render a measured metric, or "Not available" when it was never measured.
 *
 * This is the single guard against fabricated numbers: every accuracy, count
 * and percentage in the UI goes through here, and `null`/`undefined` can only
 * ever produce the "Not available" label.
 */
export function formatMetric(
  value: number | null | undefined,
  options: { as?: "percent" | "number" | "ratio"; digits?: number; label?: string } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_LABELS["not available"];
  }
  const { as = "percent", digits = 1 } = options;
  if (as === "percent") {
    const percent = value <= 1 && value >= 0 ? value * 100 : value;
    return `${percent.toFixed(digits)}%`;
  }
  if (as === "ratio") {
    return value.toFixed(digits);
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Confidence in [0,1] as a percentage string. */
export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Not available";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDate(iso: string | null | undefined, style: "short" | "long" | "time" = "short"): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  if (style === "time") {
    return date.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (style === "long") {
    return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  }
  return date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMinutes * 60_000) >= ms || unit === "minute") {
      return formatter.format(Math.round(diffMs / ms), unit);
    }
  }
  return formatter.format(0, "minute");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "Not available";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

/** Shorten a checksum for display without hiding that it is a hash. */
export function shortChecksum(checksum: string | null | undefined, length = 12): string {
  if (!checksum) return "Not available";
  return checksum.length <= length ? checksum : `${checksum.slice(0, length)}…`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
