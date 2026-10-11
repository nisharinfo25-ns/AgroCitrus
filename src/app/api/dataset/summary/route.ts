/**
 * GET /api/dataset/summary
 *
 * The Dataset Manager's read model: what the dataset contains, right now, with
 * real numbers only.
 *
 * Sources, in priority order:
 *   1. `dataset_metadata` in PostgreSQL - what production is pinned to;
 *   2. `data/citrus/processed/split_manifest.json` - what this machine holds.
 *
 * If neither exists the response says "Dataset setup required" rather than
 * rendering zeros. A zero would read as "an empty dataset"; the truth is
 * "nothing configured yet", and the two need different instructions.
 */

import { requireUser } from "@/lib/auth";
import { execCliStatus } from "@/lib/ml/cli";
import { fail, ok, serverLog } from "@/lib/server";
import type { DatasetMetadata } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface DatasetSummary {
  available: boolean;
  headline: string;
  dataset: DatasetMetadata | null;
  counts: {
    total: number | null;
    class_count: number | null;
    parts: string[];
    by_part: Record<string, Record<string, number>>;
    by_split: Record<string, number>;
  };
  splits: {
    seed: number | null;
    ratios: Record<string, number>;
    counts: Record<string, Record<string, number>>;
  } | null;
  license: { name: string | null; url: string | null; doi: string | null; attribution: string | null };
  source: { url: string; landing_page: string | null };
  message: string;
}

const EMPTY: DatasetSummary["counts"] = {
  total: null,
  class_count: null,
  parts: [],
  by_part: {},
  by_split: {},
};

export async function GET() {
  try {
    const { supabase } = await requireUser();

    const { data: row } = await supabase
      .from("dataset_metadata")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // The local split manifest is what the trainer actually reads.
    let split: Record<string, unknown> | null = null;
    let localDataset: Record<string, string | undefined> = {};
    try {
      const cli = (await execCliStatus(["dataset", "status"])) as {
        split?: Record<string, unknown> | null;
        dataset?: Record<string, unknown>;
      };
      split = cli.split ?? null;
      localDataset = (cli.dataset ?? {}) as Record<string, string | undefined>;
    } catch (error) {
      serverLog("dataset.summary", "local dataset status unavailable", error);
    }

    const dataset = (row as DatasetMetadata | null) ?? null;
    const source = localDataset;

    const counts = dataset
      ? {
          total: dataset.image_count,
          class_count: dataset.class_count,
          parts: dataset.parts ?? [],
          by_part: dataset.counts_by_part ?? {},
          by_split: {},
        }
      : EMPTY;

    const body: DatasetSummary = {
      available: Boolean(dataset),
      headline: dataset
        ? `${dataset.image_count ?? "an unknown number of"} images across ${dataset.class_count ?? "?"} classes`
        : "Dataset setup required",
      dataset,
      counts,
      splits: readSplits(split),
      license: {
        name: dataset?.license ?? null,
        url: dataset?.license_url ?? null,
        doi: dataset?.doi ?? null,
        attribution: dataset?.attribution ?? null,
      },
      source: {
        url: source.source_url ?? dataset?.source_url ?? "",
        landing_page: source.landing_page ?? dataset?.landing_page ?? null,
      },
      message: dataset
        ? "Dataset metadata is recorded. Class counts below are what the model was trained on."
        : "No dataset has been prepared on this deployment yet. Run the dataset download and preparation steps.",
    };

    return ok(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fail(error, "dataset.summary");
  }
}

/** Normalises the split manifest into per-part per-split counts. */
function readSplits(split: Record<string, unknown> | null): DatasetSummary["splits"] {
  if (!split) return null;
  const parts = split.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;

  const ratios =
    typeof split.ratios === "object" && split.ratios !== null
      ? (split.ratios as Record<string, number>)
      : {};
  const seed = typeof split.seed === "number" ? split.seed : null;

  const counts: Record<string, Record<string, number>> = {};
  for (const part of parts) {
    const entry = (split.counts as Record<string, unknown> | undefined)?.[part as string];
    if (typeof entry === "object" && entry !== null) {
      counts[part as string] = entry as Record<string, number>;
    }
  }

  return { seed, ratios, counts };
}