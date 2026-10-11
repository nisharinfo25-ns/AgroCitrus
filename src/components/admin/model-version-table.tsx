"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Rocket } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMetric } from "@/lib/format";
import type { ModelStatusResponse } from "@/types";

/**
 * Model version list with activation.
 *
 * Activation is a two-step confirm because it is the one irreversible-feeling
 * action here: it changes what every user of this instance sees. A stale
 * version can be promoted straight back, but the scan records written while the
 * old version was live permanently carry its version string - which is exactly
 * why the table shows it rather than hiding the history.
 */
export function ModelVersionTable({
  versions,
  currentVersion,
  canActivate,
}: {
  versions: ModelStatusResponse["versions"];
  currentVersion: string | null;
  canActivate: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function activate(version: string) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/model/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string; published?: boolean }
        | null;

      if (!response.ok) {
        setError(payload?.error?.message ?? `Version ${version} could not be activated.`);
        setConfirming(null);
        return;
      }

      setNotice(
        payload?.message ??
          (payload?.published === false
            ? `Version ${version} is live on this machine, but its bundle was not uploaded. Other instances will not see it.`
            : `Version ${version} is now serving predictions.`),
      );
      setConfirming(null);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `The request could not be sent: ${caught.message}`
          : "The request could not be sent. The version may still have been promoted.",
      );
    } finally {
      setPending(false);
    }
  }

  if (versions.length === 0) {
    return (
      <Alert tone="info" title="No model versions found">
        Nothing has been trained on this machine or recorded in PostgreSQL. Train a model to create the first
        version.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" role="status">
          {notice}
        </Alert>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full min-w-[38rem] text-left text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Version
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                Test acc.
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                Val. acc.
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Classes
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {versions.map((entry) => {
              const isLive = entry.version === currentVersion;
              return (
                <tr key={entry.version} className={isLive ? "bg-brand-50/40" : undefined}>
                  <td className="px-3 py-2.5">
                    <span className="font-mono text-xs font-medium text-ink-900">{entry.version}</span>
                    {entry.notes ? (
                      <p className="mt-0.5 max-w-[16rem] truncate text-xs text-ink-500">{entry.notes}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge
                      tone={
                        entry.status === "production"
                          ? "success"
                          : entry.status === "candidate"
                            ? "info"
                            : entry.status === "failed"
                              ? "danger"
                              : "neutral"
                      }
                    >
                      {entry.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink-700">
                    {entry.test_accuracy === null ? "—" : formatMetric(entry.test_accuracy)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink-700">
                    {entry.validation_accuracy === null ? "—" : formatMetric(entry.validation_accuracy)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-600">
                    {entry.classes.length > 0 ? entry.classes.length : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {isLive ? (
                      <span className="text-xs font-medium text-brand-700">Live</span>
                    ) : !canActivate ? (
                      <span className="text-xs text-ink-400">Admin key required</span>
                    ) : confirming === entry.version ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          loading={pending}
                          onClick={() => activate(entry.version)}
                        >
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={pending}
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirming(entry.version)}
                        leftIcon={<Rocket className="size-3" aria-hidden="true" />}
                      >
                        Activate
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-ink-500">
        Accuracy figures are measured on the held-out test split and are reproduced exactly as reported by the
        training run. A dash means the metric was not measured, not that it was zero. Scans already recorded
        keep the version that produced them, so activating a new version never rewrites past results.
      </p>
    </div>
  );
}
