"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Database, Loader2, Rocket, ShieldCheck } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

/**
 * Admin action: run the long dataset / model jobs.
 *
 * These are deliberately not automatic. Dataset download and model training
 * take minutes to tens of minutes on CPU, and a button that silently kicks
 * off a 20-minute job the moment an admin page loads would be hostile. Each
 * action states what it does and how long it is expected to take, and the
 * admin confirms.
 *
 * Long jobs run against a server that may time out on a serverless platform.
 * The response says so plainly instead of the UI implying success.
 */
export function AdminActions({
  datasetReady,
  modelDeployed,
}: {
  datasetReady: boolean;
  modelDeployed: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{
    action: string;
    ok: boolean;
    message: string;
    detail?: string;
  } | null>(null);

  async function run(action: string, label: string, body?: object) {
    setPending(action);
    setOutcome(null);
    try {
      const response = await fetch(`/api/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;

      if (!response.ok) {
        const error = payload?.error as { message?: string; detail?: string } | undefined;
        setOutcome({
          action: label,
          ok: false,
          message: error?.message ?? `The request failed with status ${response.status}.`,
          detail: error?.detail,
        });
        return;
      }

      setOutcome({ action: label, ok: true, message: summarise(action, payload) });
      router.refresh();
    } catch (caught) {
      setOutcome({
        action: label,
        ok: false,
        message:
          caught instanceof Error
            ? `The request could not be sent: ${caught.message}`
            : "The request could not be sent. The job may still be running on the server.",
      });
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="space-y-4">
      {outcome ? (
        <Alert tone={outcome.ok ? "success" : "danger"} role="status">
          <p className="font-medium">
            {outcome.action}: {outcome.ok ? "done" : "failed"}
          </p>
          <p className="mt-1">{outcome.message}</p>
          {outcome.detail ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/5 p-2 font-mono text-xs">
              {outcome.detail}
            </pre>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <AdminAction
          icon={Database}
          title="Download and verify the dataset"
          description="Fetches the published archive, checks the class layout and records provenance in PostgreSQL. Expect several minutes on a slow connection."
          disabled={busy}
          onRun={() => run("dataset/download", "Dataset download")}
          label={pending === "dataset/download" ? "Downloading…" : "Download dataset"}
        />
        <AdminAction
          icon={ShieldCheck}
          title="Verify the local dataset"
          description="Re-reads every image on disk and re-checks counts, classes and the content checksum against the recorded manifest."
          disabled={busy || !datasetReady}
          hint={!datasetReady ? "Download the dataset first." : undefined}
          onRun={() => run("dataset/verify", "Dataset verification")}
          label={pending === "dataset/verify" ? "Verifying…" : "Verify dataset"}
        />
        <AdminAction
          icon={Rocket}
          title="Train and export a model"
          description="Runs the full transfer-learning pipeline over the prepared split and writes a new candidate version. This takes tens of minutes on CPU and will exceed a serverless request timeout."
          disabled={busy || !datasetReady}
          hint={!datasetReady ? "Prepare the dataset first." : undefined}
          onRun={() => run("model/train", "Model training")}
          label={pending === "model/train" ? "Training…" : "Train model"}
        />
      </div>

      {busy ? (
        <p className="flex items-center gap-2 text-xs text-ink-500" role="status" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Waiting for the server. Keep this page open &mdash; closing it does not stop the job.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Turn each route's real response shape into one honest sentence.
 *
 * The routes deliberately do not all return the same envelope - `model/train`
 * reports `trained` / `published` / `promoted` separately because those three
 * can genuinely disagree (trained on disk, failed to upload). Collapsing that
 * into "done" would hide the exact failure an admin needs to act on.
 */
function summarise(action: string, payload: Record<string, unknown> | null): string {
  if (!payload) return "The server returned no body.";

  if (action === "model/train") {
    const parts: string[] = [];
    parts.push(payload.trained ? "Training finished" : "Training did not complete");
    if (payload.published) parts.push("the bundle was uploaded");
    else if (payload.published === false) {
      parts.push("the bundle was NOT uploaded - it exists only on this machine");
    }
    if (payload.promoted) parts.push("and it is now serving predictions");
    else parts.push("and it is a candidate, not yet live");
    return `${parts.join(", ")}. Activate it from the version list below when you are ready.`;
  }

  if (action === "dataset/download") {
    const result = payload.result as Record<string, unknown> | undefined;
    const count = typeof result?.image_count === "number" ? result.image_count : null;
    return count === null
      ? "The download completed. The dataset panel below shows the recorded state."
      : `${count.toLocaleString()} images downloaded and recorded.`;
  }

  if (action === "model/activate") {
    return typeof payload.message === "string"
      ? payload.message
      : `Version ${String(payload.version ?? "unknown")} activated.`;
  }

  if (action === "dataset/verify") {
    const result = payload.result as Record<string, unknown> | undefined;
    return result && typeof result === "object"
      ? "Verification finished. The dataset panel below shows the outcome."
      : "Verification finished.";
  }

  return typeof payload.message === "string" ? payload.message : "The operation completed.";
}

function AdminAction({
  icon: Icon,
  title,
  description,
  onRun,
  label,
  disabled,
  hint,
}: {
  icon: typeof Database;
  title: string;
  description: string;
  onRun: () => void;
  label: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-ink-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-600">{description}</p>
          {hint ? <p className="mt-1.5 text-xs font-medium text-amber-700">{hint}</p> : null}
          <Button
            type="button"
            size="sm"
            className="mt-3"
            onClick={onRun}
            disabled={disabled}
            loading={disabled}
          >
            {label}
          </Button>
        </div>
      </div>
    </div>
  );
}
