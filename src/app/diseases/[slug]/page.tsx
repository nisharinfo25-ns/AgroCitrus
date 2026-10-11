import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BookOpen, ExternalLink } from "lucide-react";

import { Alert, PageNotice } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { DISCLAIMER, XAI_DISCLAIMER } from "@/content/diseases";
import { getDisease } from "@/lib/db/diseases";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const entry = await getDisease(slug);
  if (!entry) return { title: "Disease not found" };
  return {
    title: entry.displayName,
    description: entry.shortDescription.slice(0, 155),
  };
}

export default async function DiseaseDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const entry = await getDisease(slug);

  if (!entry) notFound();

  return (
    <div className="flex min-h-dvh flex-col bg-ink-50">
      <SiteHeader />

      <main id="main-content" className="flex-1">
        <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
          <Link
            href="/diseases"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-brand-700"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            All diseases
          </Link>

          <header className="mt-6">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={entry.isHealthy ? "success" : "danger"}>
                {entry.isHealthy ? "Healthy" : "Disease"}
              </Badge>
              <span className="text-sm text-ink-500">
                Applies to{" "}
                <span className="font-medium capitalize text-ink-700">
                  {entry.appliesTo.join(" and ")}
                </span>
              </span>
            </div>

            <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
              {entry.displayName}
            </h1>
            <p className="mt-4 text-base leading-relaxed text-ink-700">{entry.shortDescription}</p>
          </header>

          {!entry.content_complete ? (
            <Alert tone="warning" title="This entry is incomplete" className="mt-6">
              Some sections below are still empty. An administrator can finish them from the admin dashboard.
            </Alert>
          ) : null}

          <div className="mt-8 space-y-6">
            <Section title="Symptoms" items={entry.symptoms} empty="Symptoms are not documented for this class yet." />
            <Section title="Prevention" items={entry.prevention} empty="Prevention guidance is not documented yet." />
            <Section
              title="Management"
              items={entry.management}
              empty="Management guidance is not documented yet."
            />

            {entry.references.length > 0 ? (
              <Card>
                <h2 className="mb-3 text-base font-semibold text-ink-900">Where to verify this</h2>
                <p className="mb-4 text-sm text-ink-600">
                  These are the authoritative sources for this class. Prefer them over any general-purpose web
                  result.
                </p>
                <ul className="space-y-2.5">
                  {entry.references.map((reference) => {
                    const isUrl = /^https?:\/\//i.test(reference);
                    return (
                      <li key={reference} className="flex items-start gap-2 text-sm text-ink-700">
                        <BookOpen className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
                        {isUrl ? (
                          <a
                            href={reference}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-brand-700 hover:text-brand-800 hover:underline"
                          >
                            {reference}
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                          </a>
                        ) : (
                          <span>{reference}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ) : null}

            <Card>
              <h2 className="mb-3 text-base font-semibold text-ink-900">How to interpret a CitrusGuard result</h2>
              <ul className="space-y-2.5 text-sm leading-relaxed text-ink-700">
                <li>
                  A <strong>healthy</strong> result means this model found no evidence of its trained classes. It
                  cannot rule out nutrient deficiency, water stress, root problems or pests.
                </li>
                <li>
                  A <strong>diseased</strong> result is a suggestion, not a diagnosis. Compare the highlighted
                  regions with the symptoms listed above before doing anything.
                </li>
                <li>
                  Several of these diseases look similar in a photograph. Confirm with an extension service before
                  treating.
                </li>
              </ul>
            </Card>
          </div>

          <div className="mt-8 space-y-3">
            <PageNotice tone="warning" title="Not a diagnosis">
              <p>{DISCLAIMER}</p>
            </PageNotice>
            <PageNotice tone="info" title="About the Grad-CAM overlay">
              <p>{XAI_DISCLAIMER}</p>
            </PageNotice>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="inline-flex h-11 items-center rounded-xl bg-brand-700 px-5 text-sm font-medium text-white transition-colors hover:bg-brand-800"
            >
              Scan an image of this
            </Link>
            <Link
              href="/diseases"
              className="inline-flex h-11 items-center rounded-xl border border-ink-300 bg-white px-5 text-sm font-medium text-ink-800 transition-colors hover:bg-ink-50"
            >
              Browse all classes
            </Link>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function Section({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold text-ink-900">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm italic text-ink-400">{empty}</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-ink-700">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}