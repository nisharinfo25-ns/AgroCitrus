/**
 * Disease guide reads.
 *
 * The guide is public (the `disease_information_select_public` policy allows
 * anon + authenticated), so this module deliberately uses the browser-safe
 * anon client rather than a request-scoped one - no cookies are needed.
 *
 * `DISEASE_CONTENT` in `src/content/diseases.ts` is the always-available
 * fallback. A database outage therefore degrades the guide to the bundled copy
 * instead of an empty page.
 */

import "server-only";

import { createServerClientScoped } from "@/lib/supabase/client";
import { serverLog } from "@/lib/server";
import { DISEASE_CONTENT, type DiseaseEntry } from "@/content/diseases";
import type { DiseaseInformation } from "@/types";

export interface GuideEntry extends DiseaseEntry {
  /** Present only when the entry came from PostgreSQL. */
  content_complete: boolean;
  updated_at: string | null;
  source: "database" | "bundled";
}

function bundled(entry: DiseaseEntry): GuideEntry {
  return {
    ...entry,
    content_complete: entry.symptoms.length > 0 && entry.prevention.length > 0 && entry.management.length > 0,
    updated_at: null,
    source: "bundled",
  };
}

/**
 * All guide entries, sorted with the healthy class last.
 *
 * If the query fails the bundled copy is returned with `source: "bundled"`, and
 * the caller can show an unobtrusive notice rather than an error page.
 */
export async function listDiseases(): Promise<{ entries: GuideEntry[]; degraded: boolean }> {
  try {
    const supabase = await createServerClientScoped();
    const { data, error } = await supabase.from("disease_information").select("*").order("display_name");

    if (error || !data || data.length === 0) {
      if (error) serverLog("diseases", "list query failed, using bundled content", error);
      return { entries: sortEntries(Object.values(DISEASE_CONTENT).map(bundled)), degraded: Boolean(error) };
    }

    const rows = data as DiseaseInformation[];
    return { entries: sortEntries(rows.map(fromRow)), degraded: false };
  } catch (error) {
    serverLog("diseases", "list threw, using bundled content", error);
    return { entries: sortEntries(Object.values(DISEASE_CONTENT).map(bundled)), degraded: true };
  }
}

/** One entry by slug. Returns null when the slug is not documented at all. */
export async function getDisease(slug: string): Promise<GuideEntry | null> {
  try {
    const supabase = await createServerClientScoped();
    const { data, error } = await supabase
      .from("disease_information")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();

    if (!error && data) return fromRow(data as DiseaseInformation);
    if (error) serverLog("diseases", `get ${slug} failed, using bundled content`, error);
  } catch (error) {
    serverLog("diseases", `get ${slug} threw, using bundled content`, error);
  }

  const bundledEntry = DISEASE_CONTENT[slug];
  return bundledEntry ? bundled(bundledEntry) : null;
}

function fromRow(row: DiseaseInformation): GuideEntry {
  return {
    slug: row.slug,
    displayName: row.display_name,
    appliesTo: row.applies_to as GuideEntry["appliesTo"],
    isHealthy: row.is_healthy,
    shortDescription: row.short_description,
    symptoms: row.symptoms ?? [],
    prevention: row.prevention ?? [],
    management: row.management ?? [],
    references: row.reference_sources ?? row.references ?? [],
    content_complete: row.content_complete,
    updated_at: row.updated_at,
    source: "database",
  };
}

/** Diseases first (alphabetical), then the healthy baseline at the end. */
function sortEntries(entries: GuideEntry[]): GuideEntry[] {
  return entries.sort((a, b) => {
    if (a.isHealthy !== b.isHealthy) return a.isHealthy ? 1 : -1;
    return a.displayName.localeCompare(b.displayName);
  });
}