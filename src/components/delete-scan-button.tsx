"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Delete a scan.
 *
 * Two-step by design: the button becomes a confirm/cancel pair rather than
 * opening a `window.confirm`, because the record and its stored images are
 * removed permanently and there is no undo.
 */
export function DeleteScanButton({ scanId }: { scanId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/scans/${scanId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "The scan could not be deleted.");
        setConfirming(false);
        return;
      }
      // The row is gone, so the detail page is invalid - go back to the list.
      startTransition(() => {
        router.push("/scans");
        router.refresh();
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `The request could not be sent: ${caught.message}`
          : "The request could not be sent. Check your connection and try again.",
      );
    } finally {
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setConfirming(true)}
          leftIcon={<Trash2 className="size-3.5" aria-hidden="true" />}
        >
          Delete scan
        </Button>
        {error ? (
          <Alert tone="danger" className="mt-3" role="alert">
            {error}
          </Alert>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-medium text-red-900">Delete this scan permanently?</p>
      <p className="mt-1.5 text-sm leading-relaxed text-red-800">
        The record and all stored images for this scan will be removed. This cannot be undone.
      </p>
      {error ? (
        <Alert tone="danger" className="mt-3" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button variant="danger" size="sm" loading={deleting} onClick={onDelete}>
          Yes, delete it
        </Button>
        <Button variant="secondary" size="sm" disabled={deleting} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
