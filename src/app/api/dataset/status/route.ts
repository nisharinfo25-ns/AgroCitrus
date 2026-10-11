/**
 * GET /api/dataset/status
 *
 * Reports whether the dataset is configured, and where it lives *in this
 * deployment*. The distinction matters:
 *
 *   - local development: the dataset is on the developer's disk under `data/`
 *   - production:        it is in Supabase Storage `citrus-dataset/`
 *
 * `storage.configured` and `local.manifest_exists` are reported separately so
 * an operator can tell "never downloaded" from "downloaded but not synced".
 */

import { requireUser } from "@/lib/auth";
import { execCliStatus } from "@/lib/ml/cli";
import { fail, ok, serverLog } from "@/lib/server";
import type { DatasetStatusResponse } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CliStatus {
  dataset?: Record<string, unknown>;
  local?: {
    raw_dir: string;
    manifest_exists: boolean;
    split_manifest_exists: boolean;
    processed_dir: string;
  };
  manifest?: Record<string, unknown> | null;
}

export async function GET() {
  try {
    // Any signed-in user may read the dataset status; the Detect page needs it.
    const { supabase } = await requireUser();

    const [{ data: row }, cli] = await Promise.all([
      supabase
        .from("dataset_metadata")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      execCliStatus<CliStatus | null>(["dataset", "status"]).catch((error) => {
        // The Python runtime may be absent (e.g. a web-only deploy). That is a
        // real state to report, not a reason to fail the whole request.
        serverLog("dataset.status", "CLI status unavailable", error);
        return null;
      }),
    ]);

    const local = cli?.local ?? {
      raw_dir: "unavailable",
      manifest_exists: false,
      split_manifest_exists: false,
      processed_dir: "unavailable",
    };
    const localReady = Boolean(cli?.manifest);

    const configured = row?.status === "ready" || localReady;
    const status_label = configured ? "Ready" : row ? "Incomplete" : "Dataset setup required";

    const message = configured
      ? row
        ? `Dataset metadata is recorded in PostgreSQL${row.image_count ? ` (${row.image_count} images)` : ""}.`
        : "The dataset is prepared on local disk but has not been synced to PostgreSQL."
      : row
        ? "Dataset metadata exists but the status is not 'ready'. Run the dataset download and verification steps."
        : "Dataset setup required. Configure the dataset source in ml/citrusguard/config/dataset.yaml, then run `npm run ml:dataset:download`.";

    const body: DatasetStatusResponse = {
      configured,
      status_label,
      dataset: (row as DatasetStatusResponse["dataset"]) ?? null,
      local,
      message,
    };

    return ok(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return fail(error, "dataset.status");
  }
}