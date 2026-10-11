import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatConfidence,
  formatDuration,
  formatMetric,
  formatRelative,
  pluralize,
  shortChecksum,
} from "@/lib/format";

/**
 * These formatters are the app's last line of defence against fabricated
 * numbers. A metric that was never measured must render as "Not available" -
 * never as 0%, which would read as "we measured it and it scored nothing".
 */
describe("formatMetric", () => {
  it("renders a measured ratio as a percentage", () => {
    expect(formatMetric(0.8471)).toBe("84.7%");
    expect(formatMetric(0.5)).toBe("50.0%");
    expect(formatMetric(1)).toBe("100.0%");
    expect(formatMetric(0)).toBe("0.0%");
  });

  it("says 'Not available' for every unmeasured case", () => {
    expect(formatMetric(null)).toBe("Not available");
    expect(formatMetric(undefined)).toBe("Not available");
    expect(formatMetric(Number.NaN)).toBe("Not available");
    expect(formatMetric(Number.POSITIVE_INFINITY)).toBe("Not available");
  });

  it("never renders an unmeasured value as zero", () => {
    // 0.0% and "Not available" mean completely different things to a user.
    expect(formatMetric(null)).not.toBe("0.0%");
    expect(formatMetric(undefined)).not.toBe("0.0%");
  });

  it("honours the requested precision", () => {
    expect(formatMetric(0.8471, { digits: 2 })).toBe("84.71%");
    expect(formatMetric(0.8471, { digits: 0 })).toBe("85%");
  });

  it("passes a value above 1 through as an already-scaled percentage", () => {
    // A column that stores 84.7 rather than 0.847 must not become 8470%.
    expect(formatMetric(84.71)).toBe("84.7%");
  });

  it("supports number and ratio rendering", () => {
    expect(formatMetric(1234, { as: "number" })).toMatch(/1.234/);
    expect(formatMetric(0.8471, { as: "ratio" })).toBe("0.8");
  });

  it("renders a genuine zero when zero was actually measured", () => {
    // 0 accuracy is a real (bad) result and must stay visible as 0.0%.
    expect(formatMetric(0)).toBe("0.0%");
  });
});

describe("formatConfidence", () => {
  it("renders a confidence as a percentage", () => {
    expect(formatConfidence(0.9123)).toBe("91.2%");
    expect(formatConfidence(0)).toBe("0.0%");
  });

  it("says 'Not available' rather than 0% when absent", () => {
    // A low-confidence scan with a missing score must not look like a
    // confidently-zero result.
    expect(formatConfidence(null)).toBe("Not available");
    expect(formatConfidence(undefined)).toBe("Not available");
    expect(formatConfidence(Number.NaN)).toBe("Not available");
  });
});

describe("formatBytes", () => {
  it("scales to a readable unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toMatch(/1(\.0)? KB/);
    expect(formatBytes(1024 * 1024 * 29)).toMatch(/29(\.0)? MB/);
  });

  it("uses a dash for an absent value", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("renders minutes and seconds for a training run", () => {
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(45)).toBe("45.0s");
  });

  it("says 'Not available' rather than 0s when no duration was recorded", () => {
    // "0.0s" would claim training took no time at all.
    expect(formatDuration(null)).toBe("Not available");
    expect(formatDuration(undefined)).toBe("Not available");
    expect(formatDuration(Number.NaN)).toBe("Not available");
  });
});

describe("shortChecksum", () => {
  it("truncates for display while keeping it recognisable", () => {
    const full = "a".repeat(64);
    const short = shortChecksum(full);
    expect(short.length).toBeLessThan(full.length);
    expect(full.startsWith(short.replace(/…$/, "").slice(0, 4))).toBe(true);
  });

  it("marks an absent checksum rather than showing an empty string", () => {
    expect(shortChecksum(null)).not.toBe("");
    expect(shortChecksum(undefined)).not.toBe("");
  });
});

describe("pluralize", () => {
  it("returns the word only, so the count can be styled separately", () => {
    expect(pluralize(1, "scan")).toBe("scan");
    expect(pluralize(2, "scan")).toBe("scans");
    expect(pluralize(0, "scan")).toBe("scans");
  });

  it("accepts an irregular plural", () => {
    expect(pluralize(1, "analysis", "analyses")).toBe("analysis");
    expect(pluralize(3, "analysis", "analyses")).toBe("analyses");
  });
});

describe("formatRelative", () => {
  it("does not invent a timestamp", () => {
    expect(formatRelative(null)).toBe("—");
    expect(formatRelative("not-a-date")).toBe("—");
  });

  it("describes a recent time in words", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatRelative(twoHoursAgo)).toMatch(/hour/i);
  });
});