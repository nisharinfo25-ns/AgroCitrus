import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { DeleteScanButton } from "@/components/delete-scan-button";
import { ResultPanel } from "@/components/detect/result-panel";
import { PageNotice } from "@/components/ui/alert";
import { requireUser } from "@/lib/auth";
import { getScan, signScanImagesSafe } from "@/lib/db/scans";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/client";
import type { ScanWithUrls } from "@/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const { supabase } = await requireUser();
  const scan = await getScan(supabase, id);

  // A missing scan is a 404, not a metadata leak: the title never reveals
  // whether an id exists for another user.
  if (!scan) return { title: "Scan not found" };

  return {
    title: scan.predicted_class_display ?? "Scan result",
    description: "Scan result, confidence, Grad-CAM explanation and image quality report.",
  };
}

export default async function ScanDetailPage({ params }: PageProps) {
  const { id } = await params;
  const { supabase } = await requireUser();

  // RLS makes this return null for a scan the caller does not own, so the
  // 404 below is identical whether the id is wrong or simply not theirs.
  const scan = await getScan(supabase, id);
  if (!scan) notFound();

  // Optional decoration only: the service-role key is needed to mint signed
  // URLs, and its absence must not crash an otherwise valid scan page.
  const urls = await signScanImagesSafe(
    isAdminConfigured() ? createAdminClient() : null,
    scan,
  );
  const withUrls: ScanWithUrls = { ...scan, ...urls };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/scans"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-brand-700"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            All scans
          </Link>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink-900">Scan result</h1>
        </div>
      </div>

      <ResultPanel scan={withUrls} />

      <div className="border-t border-ink-200 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-md">
            <h2 className="text-sm font-semibold text-ink-900">Remove this scan</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-600">
              Deleting removes the record and every stored image for this scan from private storage. It cannot be
              undone.
            </p>
          </div>
          <DeleteScanButton scanId={scan.id} />
        </div>
      </div>

      {scan.prediction_state === "failed" ? (
        <PageNotice tone="warning" title="Why this scan is incomplete">
          The prediction pipeline reported an error
          {scan.error_code ? (
            <>
              {" "}
              (<code className="font-mono text-xs">{scan.error_code}</code>)
            </>
          ) : null}
          . The technical detail is in the server logs. No class was predicted, and none has been guessed.
        </PageNotice>
      ) : null}
    </div>
  );
}
