import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, BookOpen, ExternalLink } from "lucide-react";

import { DiseaseEditor } from "@/components/admin/disease-editor";
import { PageNotice } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireAdmin } from "@/lib/auth";
import type { DiseaseInformation } from "@/types";

export const metadata: Metadata = {
  title: "Disease content",
  description: "Write and edit the reference content shown in the disease guide.",
};

export const dynamic = "force-dynamic";

export default async function AdminDiseasesPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  const { supabase } = await requireAdmin();
  const { slug } = await searchParams;

  const [entriesResult, productionResult] = await Promise.all([
    supabase.from("disease_information").select("*").order("display_name"),
    supabase
      .from("model_versions")
      .select("classes")
      .eq("status", "production")
      .limit(1)
      .maybeSingle(),
  ]);

  const entries = (entriesResult.data ?? []) as DiseaseInformation[];
  const modelClasses = (productionResult.data?.classes ?? []) as string[];

  const selected = slug ? entries.find((entry) => entry.slug === slug) ?? null : null;
  const undocumented = modelClasses.filter(
    (name) => !entries.some((entry) => entry.slug === name),
  );

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to admin
        </Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink-900">Disease content</h1>
        <p className="mt-2 text-sm text-ink-600">
          Reference text shown in the public disease guide. Content can only be written for a class the
          deployed model can actually predict.
        </p>
      </header>

      {undocumented.length > 0 ? (
        <PageNotice tone="warning" title={`${undocumented.length} predicted class has no entry`}>
          The model can return{" "}
          <span className="font-mono text-xs">{undocumented.join(", ")}</span>. Until each has an entry, a scan
          of one of those classes lands on the guide with nothing to read. Select one below to write it.
        </PageNotice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_1fr]">
        <Card>
          <CardHeader
            title="Classes"
            description="Model classes and their entries."
            action={<BookOpen className="size-4 text-ink-400" aria-hidden="true" />}
          />

          {entriesResult.error ? (
            <p className="text-sm text-ink-600">
              The disease library could not be loaded: {entriesResult.error.message}
            </p>
          ) : entries.length === 0 ? (
            <EmptyState
              title="No entries yet"
              description={
                modelClasses.length > 0
                  ? "The model is deployed but the guide has no reference content. Create the first entry using the form."
                  : "No model is deployed, so there are no classes to document yet."
              }
              icon={BookOpen}
            />
          ) : (
            <ul className="space-y-1.5">
              {entries.map((entry) => {
                const active = entry.slug === selected?.slug;
                return (
                  <li key={entry.slug}>
                    <Link
                      href={`/admin/diseases?slug=${encodeURIComponent(entry.slug)}`}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        active
                          ? "border-brand-300 bg-brand-50 text-brand-900"
                          : "border-ink-200 bg-white text-ink-800 hover:bg-ink-50"
                      }`}
                    >
                      <span className="min-w-0 truncate font-medium">{entry.display_name}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {!entry.content_complete ? (
                          <Badge tone="warning">Incomplete</Badge>
                        ) : null}
                        {entry.is_healthy ? <Badge tone="success">Healthy</Badge> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          {modelClasses.length > 0 ? (
            <p className="mt-4 border-t border-ink-100 pt-3 text-xs leading-relaxed text-ink-500">
              The guide itself lives at{" "}
              <Link href="/diseases" className="font-medium text-brand-700 hover:text-brand-800">
                /diseases
              </Link>
              <ExternalLink className="ml-0.5 inline size-2.5" aria-hidden="true" />
            </p>
          ) : null}
        </Card>

        <Card>
          <CardHeader
            title={selected ? `Editing: ${selected.display_name}` : "Create or edit an entry"}
            description={
              selected
                ? "Changes are published to the guide immediately."
                : slug
                  ? `No entry exists for "${slug}". Creating one below.`
                  : "Pick a class on the left to edit it, or fill in the form to create a new entry."
            }
          />
          <DiseaseEditor
            key={selected?.slug ?? slug ?? "new"}
            entry={selected}
            modelClasses={modelClasses}
            modelConfigured={modelClasses.length > 0}
          />
        </Card>
      </div>
    </div>
  );
}