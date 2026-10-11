import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BookOpen, CircleCheck, CircleDot, Info } from "lucide-react";

import { PageNotice } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { DISCLAIMER } from "@/content/diseases";
import { listDiseases } from "@/lib/db/diseases";

export const metadata: Metadata = {
  title: "Disease guide",
  description:
    "Symptoms, prevention and management for the citrus diseases covered by the CitrusGuard model: black spot, canker, greening, melanose and scab.",
};

export default async function DiseasesPage() {
  const { entries, degraded } = await listDiseases();

  return (
    <div className="flex min-h-dvh flex-col bg-ink-50">
      <SiteHeader />

      <main id="main-content" className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
          <header>
            <Badge tone="brand" icon={<BookOpen className="size-3.5" aria-hidden="true" />}>
              Reference
            </Badge>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">Disease guide</h1>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink-600">
              Every class the CitrusGuard model can predict, with the symptoms that distinguish it, the cultural
              practices that reduce risk, and what to do once a case is confirmed. Only classes present in the
              published training dataset appear here.
            </p>
          </header>

          {degraded ? (
            <PageNotice tone="warning" title="Showing the bundled reference copy" className="mt-6">
              The disease library could not be read from the database, so this page is serving the content bundled
              with the application. Everything shown is still accurate.
            </PageNotice>
          ) : null}

          {entries.length === 0 ? (
            <div className="card mt-8 p-8 text-center">
              <CircleDot className="mx-auto size-8 text-ink-300" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold text-ink-800">No disease content is configured yet</p>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-600">
                An administrator can add entries for each class the model predicts from the admin dashboard.
              </p>
            </div>
          ) : (
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((entry) => (
                <li key={entry.slug}>
                  <Link
                    href={`/diseases/${entry.slug}`}
                    className="card-interactive flex h-full flex-col p-5 no-underline"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-base font-semibold text-ink-900">{entry.displayName}</h2>
                      <Badge tone={entry.isHealthy ? "success" : "danger"}>
                        {entry.isHealthy ? "Healthy" : "Disease"}
                      </Badge>
                    </div>

                    <p className="mt-2.5 line-clamp-4 text-sm leading-relaxed text-ink-600">
                      {entry.shortDescription}
                    </p>

                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
                      {entry.appliesTo.map((part) => (
                        <span key={part} className="rounded-md bg-ink-100 px-2 py-0.5 text-xs capitalize text-ink-700">
                          {part}
                        </span>
                      ))}
                      {!entry.content_complete ? (
                        <Badge tone="warning">Incomplete</Badge>
                      ) : (
                        <Badge tone="success" icon={<CircleCheck className="size-3" aria-hidden="true" />}>
                          Complete
                        </Badge>
                      )}
                    </div>

                    <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-700">
                      Read more
                      <ArrowRight className="size-3.5" aria-hidden="true" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <PageNotice tone="info" title="General information only" className="mt-10">
            <p>{DISCLAIMER}</p>
            <p className="mt-2 flex items-start gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              No pesticide, dose or product is named anywhere on this site, because registered products and label
              approvals differ by country.
            </p>
          </PageNotice>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}