/**
 * GET  /api/admin/diseases - list reference content, plus content gaps
 * POST /api/admin/diseases - create or update one disease entry
 *
 * Two rules this route enforces that the UI cannot:
 *
 *   1. An entry may only be written for a class the *current model* can
 *      actually predict. Otherwise the guide would advertise a result the
 *      classifier will never emit.
 *   2. `content_complete` is derived from the content, never asserted. An entry
 *      missing any of symptoms / prevention / management is visibly incomplete
 *      in the guide instead of silently reading as finished.
 *
 * `class_content_gaps()` (migration 0002) returns one row per production class,
 * so the admin can see exactly which classes still need documentation.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, fail, ok } from "@/lib/server";
import type { DiseaseInformation } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DiseaseSchema = z.object({
  slug: z.string().regex(SLUG_RE, "Slug must be lowercase letters, numbers and hyphens."),
  display_name: z.string().min(1).max(120),
  applies_to: z.array(z.enum(["leaf", "fruit"])).min(1, "Choose at least one input type."),
  is_healthy: z.boolean().default(false),
  short_description: z.string().min(1).max(2000),
  symptoms: z.array(z.string().min(1).max(500)).max(20).default([]),
  prevention: z.array(z.string().min(1).max(500)).max(20).default([]),
  management: z.array(z.string().min(1).max(500)).max(20).default([]),
  references: z.array(z.string().url("References must be URLs.")).max(20).default([]),
});

export async function GET() {
  try {
    const { supabase } = await requireAdmin();

    const [entries, gaps, production] = await Promise.all([
      supabase.from("disease_information").select("*").order("display_name"),
      supabase.rpc("class_content_gaps"),
      supabase
        .from("model_versions")
        .select("classes")
        .eq("status", "production")
        .limit(1)
        .maybeSingle(),
    ]);

    if (entries.error) {
      throw new AppError("internal_error", "The disease library could not be loaded.", {
        detail: entries.error.message,
      });
    }

    // The RPC is a set-returning function, so PostgREST hands back an array.
    // `null` means "unknown" (function not installed), which the UI renders as
    // "Not available" - distinct from an empty array meaning "no gaps".
    const gapRows = gaps.error ? null : ((gaps.data ?? []) as Array<{ slug: string; has_content: boolean }>);

    return ok({
      entries: (entries.data ?? []) as DiseaseInformation[],
      gaps: gapRows,
      missing: gapRows?.filter((row) => !row.has_content).map((row) => row.slug) ?? null,
      model_classes: (production.data?.classes ?? []) as string[],
    });
  } catch (error) {
    return fail(error, "admin.diseases.list");
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { supabase } = await requireAdmin();

    const body = DiseaseSchema.parse(await request.json());

    const { data: production } = await supabase
      .from("model_versions")
      .select("classes")
      .eq("status", "production")
      .limit(1)
      .maybeSingle();

    const known = (production?.classes ?? []) as string[];
    if (known.length > 0 && !known.includes(body.slug)) {
      throw new AppError(
        "validation_error",
        `"${body.slug}" is not a class the current model can predict. Known classes: ${known.join(", ")}.`,
      );
    }

    const { data, error } = await supabase
      .from("disease_information")
      .upsert(
        {
          ...body,
          content_complete:
            body.symptoms.length > 0 && body.prevention.length > 0 && body.management.length > 0,
        },
        { onConflict: "slug" },
      )
      .select("*")
      .single();

    if (error) {
      throw new AppError("internal_error", "The disease entry could not be saved.", {
        detail: error.message,
      });
    }

    return ok({ entry: data as DiseaseInformation });
  } catch (error) {
    return fail(error, "admin.diseases.save");
  }
}