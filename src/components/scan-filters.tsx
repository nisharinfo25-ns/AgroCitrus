"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Filter, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/**
 * History filters.
 *
 * Filters live in the URL, not component state, so a filtered history is
 * shareable, survives a refresh, and works with the server-rendered list. The
 * form submits a real GET rather than pushing searchParams imperatively, which
 * keeps it working without JavaScript.
 */
export function ScanFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(params.get("q") ?? "");

  const status = params.get("status") ?? "all";
  const inputType = params.get("type") ?? "all";
  const lowConfidence = params.get("low") === "1";
  const sort = params.get("sort") ?? "newest";
  const active =
    status !== "all" || inputType !== "all" || lowConfidence || sort !== "newest" || Boolean(params.get("q"));

  function apply(changes: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "" || value === "all") next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete("page");
    const query = next.toString();
    router.push(query ? `/scans?${query}` : "/scans");
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply({ q: term.trim() || null });
  }

  return (
    <form
      onSubmit={onSearch}
      className="rounded-[var(--radius-card)] border border-ink-200 bg-white p-4"
      role="search"
      aria-label="Filter scan history"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="flex-1">
          <label htmlFor="q" className="block text-xs font-medium uppercase tracking-wide text-ink-500">
            Search
          </label>
          <div className="mt-1 flex gap-2">
            <Input
              id="q"
              name="q"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Disease name or model version"
              className="flex-1"
            />
            <Button type="submit" variant="secondary" leftIcon={<Search className="size-4" aria-hidden="true" />}>
              Search
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Select
            aria-label="Filter by health status"
            value={status}
            onChange={(event) => apply({ status: event.target.value })}
          >
            <option value="all">All results</option>
            <option value="healthy">Healthy only</option>
            <option value="diseased">Diseased only</option>
          </Select>

          <Select
            aria-label="Filter by input type"
            value={inputType}
            onChange={(event) => apply({ type: event.target.value })}
          >
            <option value="all">Leaf &amp; fruit</option>
            <option value="leaf">Leaves</option>
            <option value="fruit">Fruits</option>
          </Select>

          <Select
            aria-label="Sort scans"
            value={sort}
            onChange={(event) => apply({ sort: event.target.value })}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="confidence">Highest confidence</option>
          </Select>

          <Button
            type="button"
            variant={lowConfidence ? "subtle" : "secondary"}
            aria-pressed={lowConfidence}
            onClick={() => apply({ low: lowConfidence ? null : "1" })}
            leftIcon={<Filter className="size-4" aria-hidden="true" />}
          >
            {lowConfidence ? "Low conf. only" : "All confidence"}
          </Button>
        </div>
      </div>

      {active ? (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-ink-100 pt-3">
          <p className="text-xs text-ink-600">Filters are active. Results are limited to what matches.</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setTerm("");
              router.push("/scans");
            }}
            leftIcon={<RotateCcw className="size-3.5" aria-hidden="true" />}
          >
            Clear all
          </Button>
        </div>
      ) : null}
    </form>
  );
}

/** Pagination. Preserves the active filter set. */
export function ScanPagination({
  page,
  totalPages,
  total,
  className,
}: {
  page: number;
  totalPages: number;
  total: number;
  className?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  if (totalPages <= 1) return null;

  const go = (next: number) => {
    const query = new URLSearchParams(params.toString());
    if (next <= 1) query.delete("page");
    else query.set("page", String(next));
    const value = query.toString();
    router.push(value ? `/scans?${value}` : "/scans");
  };

  return (
    <nav
      aria-label="Scan history pages"
      className={cn("flex items-center justify-between gap-3 border-t border-ink-200 pt-4", className)}
    >
      <p className="text-sm text-ink-600">
        Page <span className="font-medium text-ink-900">{page}</span> of {totalPages} &middot; {total}{" "}
        {total === 1 ? "scan" : "scans"}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => go(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
