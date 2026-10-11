"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Save } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/input";
import type { DiseaseInformation } from "@/types";

/**
 * Edit one disease entry.
 *
 * The three list fields (symptoms / prevention / management) are edited as
 * one-per-line text rather than a repeating row editor. Reference content is
 * prose that an agronomist writes in one pass; a line-per-item textarea matches
 * how it is authored, and the server splits it. Losing bullet UI to gain a
 * faithful editing experience is the right trade for admin tooling that is used
 * a handful of times per disease.
 *
 * `content_complete` is never sent. The server derives it from the three lists,
 * so a client cannot assert an entry is finished when a section is empty.
 */
export function DiseaseEditor({
  entry,
  modelClasses,
  modelConfigured,
}: {
  entry: DiseaseInformation | null;
  modelClasses: string[];
  modelConfigured: boolean;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(entry?.slug ?? "");
  const [displayName, setDisplayName] = useState(entry?.display_name ?? "");
  const [description, setDescription] = useState(entry?.short_description ?? "");
  const [appliesTo, setAppliesTo] = useState<string[]>(
    Array.isArray(entry?.applies_to) ? entry.applies_to : ["leaf"],
  );
  const [isHealthy, setIsHealthy] = useState(Boolean(entry?.is_healthy));
  const [symptoms, setSymptoms] = useState((entry?.symptoms ?? []).join("\n"));
  const [prevention, setPrevention] = useState((entry?.prevention ?? []).join("\n"));
  const [management, setManagement] = useState((entry?.management ?? []).join("\n"));
  const [references, setReferences] = useState((entry?.references ?? []).join("\n"));

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const lines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const slugNotInModel =
    modelConfigured && slug.length > 0 && !modelClasses.includes(slug);

  const complete =
    lines(symptoms).length > 0 &&
    lines(prevention).length > 0 &&
    lines(management).length > 0;

  function togglePart(part: string) {
    setAppliesTo((current) =>
      current.includes(part) ? current.filter((p) => p !== part) : [...current, part],
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/admin/diseases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          display_name: displayName.trim(),
          applies_to: appliesTo,
          is_healthy: isHealthy,
          short_description: description.trim(),
          symptoms: lines(symptoms),
          prevention: lines(prevention),
          management: lines(management),
          references: lines(references),
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; detail?: string } }
        | null;

      if (!response.ok) {
        setError(
          [payload?.error?.message, payload?.error?.detail].filter(Boolean).join(" ") ||
            "The entry could not be saved.",
        );
        return;
      }

      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `The request could not be sent: ${caught.message}`
          : "The request could not be sent.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {saved && !error ? (
        <Alert tone="success" role="status">
          Entry saved. The public guide now shows this content.
        </Alert>
      ) : null}

      {slugNotInModel ? (
        <Alert tone="warning" title="This slug is not a model class">
          The deployed model predicts{" "}
          <span className="font-mono text-xs">{modelClasses.join(", ") || "(no classes)"}</span>. The server
          will reject this entry because the guide would advertise a result the classifier never emits.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Slug"
          htmlFor="slug"
          required
          hint="Lowercase letters, numbers and hyphens. Must match a model class name."
        >
          <Input
            id="slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              setSaved(false);
            }}
            required
            placeholder="greening"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
          />
        </Field>

        <Field label="Display name" htmlFor="display_name" required>
          <Input
            id="display_name"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setSaved(false);
            }}
            required
            placeholder="Citrus greening"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="text-sm font-medium text-ink-800">Applies to</legend>
          <div className="mt-2 flex gap-4">
            {(["leaf", "fruit"] as const).map((part) => (
              <label key={part} className="flex items-center gap-2 text-sm text-ink-700">
                <Checkbox
                  checked={appliesTo.includes(part)}
                  onChange={() => togglePart(part)}
                />
                {part === "leaf" ? "Leaves" : "Fruit"}
              </label>
            ))}
          </div>
          {appliesTo.length === 0 ? (
            <p className="mt-1.5 text-xs text-amber-700">
              Choose at least one &mdash; the guide filters by input type.
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-ink-800">Classification</legend>
          <label className="mt-2 flex items-center gap-2 text-sm text-ink-700">
            <Checkbox
              checked={isHealthy}
              onChange={(event) => {
                setIsHealthy(event.target.checked);
                setSaved(false);
              }}
            />
            This is a healthy class (no disease)
          </label>
          <p className="mt-1.5 text-xs text-ink-500">
            Healthy classes are styled differently and excluded from disease counts.
          </p>
        </fieldset>
      </div>

      <Field
        label="Short description"
        htmlFor="short_description"
        required
        hint="One or two sentences. Shown on the guide index and at the top of the disease page."
      >
        <Textarea
          id="short_description"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            setSaved(false);
          }}
          required
          rows={3}
        />
      </Field>

      <Field
        label="Symptoms"
        htmlFor="symptoms"
        hint="One symptom per line."
      >
        <Textarea
          id="symptoms"
          value={symptoms}
          onChange={(event) => {
            setSymptoms(event.target.value);
            setSaved(false);
          }}
          rows={5}
        />
      </Field>

      <Field label="Prevention" htmlFor="prevention" hint="One action per line.">
        <Textarea
          id="prevention"
          value={prevention}
          onChange={(event) => {
            setPrevention(event.target.value);
            setSaved(false);
          }}
          rows={5}
        />
      </Field>

      <Field label="Management" htmlFor="management" hint="One action per line.">
        <Textarea
          id="management"
          value={management}
          onChange={(event) => {
            setManagement(event.target.value);
            setSaved(false);
          }}
          rows={5}
        />
      </Field>

      <Field
        label="References"
        htmlFor="references"
        hint="One URL per line. Each must be a full http(s) URL."
      >
        <Textarea
          id="references"
          value={references}
          onChange={(event) => {
            setReferences(event.target.value);
            setSaved(false);
          }}
          rows={3}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-4">
        <Button
          type="submit"
          loading={pending}
          leftIcon={<Save className="size-4" aria-hidden="true" />}
        >
          {entry ? "Update entry" : "Create entry"}
        </Button>
        <Badge tone={complete ? "success" : "warning"}>
          {complete ? "Complete" : "Incomplete &mdash; missing a required section"}
        </Badge>
        <p className="text-xs text-ink-500">
          An entry is marked complete only when symptoms, prevention and management are all non-empty.
        </p>
        {pending ? (
          <span className="flex items-center gap-1.5 text-xs text-ink-500">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            Saving
          </span>
        ) : null}
      </div>
    </form>
  );
}