import type { Metadata } from "next";
import Link from "next/link";
import { Camera, Plus } from "lucide-react";

import { ScanCard } from "@/components/scan-card";
import { ScanFilters, ScanPagination } from "@/components/scan-filters";
import { EmptyState } from "@/components/ui/empty-state";
import { requireUser } from "@/lib/auth";
import { listScans, signScanImagesSafe, type ListScansParams } from "@/lib/db/scans";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/client";

export const metadata: Metadata = {
  title: "My scans",
  description: "Every image you have analysed, with its result, confidence and explanation.",
};

export const dynamic = "force-dynamic";

const PAGE_SIZE = 12;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ScansPage({ searchParams }: PageProps) {
  const { supabase } = await requireUser();
  const query = await searchParams;

  const page = clamp(toInt(query.page, 1), 1, 10_000);
  // "all" is a real value in the allowed set, not just the fallback: it is what
  // the filter bar omits from the URL to mean "do not narrow".
  const status = toEnum(query.status, ["all", "healthy", "diseased"] as const, "all");
  const inputType = toEnum(query.inputType, ["all", "leaf", "fruit"] as const, "all");
  const sort = toEnum(query.sort, ["newest", "oldest", "confidence"] as const, "newest");

  const filters = {
    page,
    pageSize: PAGE_SIZE,
    status: status as ListScansParams["status"],
    inputType: inputType as ListScansParams["inputType"],
    lowConfidence: query.low === "1",
    search: typeof query.q === "string" ? query.q : undefined,
    sort,
  };

  const { scans, total, totalPages } = await listScans(supabase, filters);

  // Signed URLs are minted only for rows RLS already confirmed belong to the
  // caller, and only for the page being viewed.
  // Signed thumbnails are optional; see the note in scans/[id]/page.tsx.
  const admin = isAdminConfigured() ? createAdminClient() : null;
  const withUrls = await Promise.all(
    scans.map(async (scan) => ({
      scan,
      urls: await signScanImagesSafe(admin, scan),
    })),
  );

  const hasFilters =
    status !== "all" || inputType !== "all" || filters.lowConfidence || sort !== "newest" || Boolean(filters.search);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">My scans</h1>
          <p className="mt-2 text-sm text-ink-600">
            {total === 0
              ? "Nothing analysed yet."
              : `${total} ${total === 1 ? "scan" : "scans"} on record. Only you can see these.`}
          </p>
        </div>
        <Link
          href="/detect"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800"
        >
          <Plus className="size-4" aria-hidden="true" />
          New scan
        </Link>
      </header>

      <ScanFilters />

      {withUrls.length === 0 ? (
        hasFilters ? (
          <EmptyState
            icon={Camera}
            title="No scans match these filters"
            description="Nothing in your history matches the current filters. Clear them to see everything you have analysed."
          />
        ) : (
          <EmptyState
            icon={Camera}
            title="No scans yet"
            description="Once you analyse an image it will appear here with its result, confidence and Grad-CAM explanation. Nothing is stored until you do."
            action={
              <Link
                href="/detect"
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800"
              >
                <Plus className="size-4" aria-hidden="true" />
                Analyse your first image
              </Link>
            }
          />
        )
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {withUrls.map(({ scan, urls }) => (
              <ScanCard
                key={scan.id}
                scan={scan}
                imageUrl={urls.image_url}
                heatmapUrl={urls.heatmap_url}
                href={`/scans/${scan.id}`}
              />
            ))}
          </ul>
          <ScanPagination page={page} totalPages={totalPages} total={total} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Query parameter helpers
// ---------------------------------------------------------------------------
function toInt(value: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Only the listed values are honoured; anything else falls back to `fallback`. */
function toEnum<const T extends readonly string[]>(
  value: string | string[] | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T[number]) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
