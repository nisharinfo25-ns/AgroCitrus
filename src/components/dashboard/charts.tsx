"use client";

import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Line,
  LineChart,
} from "recharts";

import { EmptyState } from "@/components/ui/empty-state";
import { formatMetric } from "@/lib/format";
import type { DashboardStats } from "@/types";

/**
 * Dashboard charts.
 *
 * Every series is derived from real scan rows. When a series is empty the chart
 * is replaced by a labelled empty state - never a flat axis or a zero-height
 * bar, which reads as "measured and found nothing".
 */

const PALETTE = ["#15803d", "#b45309", "#b91c1c", "#1d4ed8", "#7c3aed", "#0891b2", "#a16207"];

/** Scans per day over the last 30 days. */
export function ScanTrendChart({ trend }: { trend: DashboardStats["trend"] }) {
  if (trend.length === 0) {
    return (
      <EmptyState
        compact
        title="No scans in the last 30 days"
        description="Once you analyse images, the daily count appears here."
      />
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickLine={false}
            axisLine={{ stroke: "#cbd5e1" }}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              borderRadius: "0.5rem",
              border: "1px solid #e2e8f0",
              fontSize: "0.8125rem",
              boxShadow: "var(--shadow-raised)",
            }}
            labelStyle={{ fontWeight: 600, color: "#0f172a" }}
            formatter={(value: number) => [value, "Scans"]}
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke="#15803d"
            strokeWidth={2}
            dot={{ r: 2.5, fill: "#15803d" }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Predicted class distribution, excluding the healthy baseline. */
export function ClassDistributionChart({ data }: { data: DashboardStats["by_class"] }) {
  if (data.length === 0) {
    return (
      <EmptyState
        compact
        title="No disease predictions yet"
        description="Charts appear once a scan returns a diseased class."
      />
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-center">
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="class_name"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={2}
              stroke="#ffffff"
              strokeWidth={2}
            >
              {data.map((entry, index) => (
                <Cell key={entry.class_name} fill={PALETTE[index % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                borderRadius: "0.5rem",
                border: "1px solid #e2e8f0",
                fontSize: "0.8125rem",
              }}
              formatter={(value: number, name: string) => [value, name]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="space-y-2">
        {data.map((entry, index) => {
          const total = data.reduce((sum, item) => sum + item.count, 0);
          const share = total > 0 ? (entry.count / total) * 100 : 0;
          return (
            <li key={entry.class_name} className="flex items-center gap-2.5 text-sm">
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-sm"
                style={{ backgroundColor: PALETTE[index % PALETTE.length] }}
              />
              <span className="min-w-0 flex-1 truncate text-ink-700">{entry.class_name}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-ink-500">
                {entry.count} &middot; {share.toFixed(0)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Leaf vs fruit counts. */
export function InputTypeChart({ data }: { data: DashboardStats["by_input_type"] }) {
  if (data.length === 0) {
    return (
      <EmptyState
        compact
        title="No input types recorded"
        description="The leaf-vs-fruit stage has not run on any scan yet."
      />
    );
  }

  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickLine={false}
            axisLine={{ stroke: "#cbd5e1" }}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="input_type"
            tick={{ fontSize: 12, fill: "#334155" }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(value: string) => value.charAt(0).toUpperCase() + value.slice(1)}
          />
          <Tooltip
            contentStyle={{ borderRadius: "0.5rem", border: "1px solid #e2e8f0", fontSize: "0.8125rem" }}
            formatter={(value: number) => [value, "Scans"]}
            cursor={{ fill: "#f1f5f9" }}
          />
          <Bar dataKey="count" fill="#15803d" radius={[0, 4, 4, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A small inline sparkline-free percentage used in the stat tiles. */
export function PercentStat({
  value,
  label,
  tone = "brand",
}: {
  value: number | null;
  label: string;
  tone?: "brand" | "amber" | "slate";
}) {
  const toneClass = {
    brand: "text-brand-700",
    amber: "text-amber-700",
    slate: "text-ink-900",
  }[tone];

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${toneClass}`}>
        {value === null ? (
          <span className="text-base font-normal italic text-ink-400">Not available</span>
        ) : (
          formatMetric(value, { as: "percent" })
        )}
      </p>
    </div>
  );
}
