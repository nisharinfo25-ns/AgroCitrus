"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImageUp, Loader2, Sparkles, Upload, X } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox, Field } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import type { ScanWithUrls } from "@/types";

/** Mirrors the server-side limit in `validateUpload` so the user finds out early. */
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

export interface UploaderProps {
  /** When false the form is replaced by a setup notice by the parent. */
  disabled?: boolean;
  minConfidence: number;
}

/**
 * The upload and analysis form.
 *
 * Client-side checks here are a courtesy, not a control: the server re-validates
 * size, MIME and magic bytes, and is the only thing that matters. A failure
 * response is always rendered - never swallowed into a console log.
 */
export function ScanUploader({ minConfidence }: UploaderProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [enableGradCam, setEnableGradCam] = useState(true);
  const [partChoice, setPartChoice] = useState<"auto" | "leaf" | "fruit">("auto");
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    message: string;
    reasons?: string[];
    tone?: "warning" | "danger";
  } | null>(null);
  // Guards against a double click landing two requests before React re-renders
  // and disables the button: a second POST would train nothing new but would
  // create a duplicate scan row and a second model run.
  const inFlight = useRef(false);

  const clearPreview = useCallback(() => {
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, []);

  const accept = useCallback(
    (next: File | null) => {
      setError(null);
      if (!next) {
        setFile(null);
        clearPreview();
        return;
      }
      if (!ACCEPTED.includes(next.type)) {
        setFile(null);
        clearPreview();
        setError({ message: `"${next.type || "unknown"}" is not a supported format. Use a JPEG, PNG or WebP image.` });
        return;
      }
      if (next.size > MAX_BYTES) {
        setFile(null);
        clearPreview();
        setError({
          message: `That image is ${(next.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
        });
        return;
      }
      setFile(next);
      clearPreview();
      setPreview(URL.createObjectURL(next));
    },
    [clearPreview],
  );

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    accept(event.dataTransfer.files?.[0] ?? null);
  }

  async function onSubmit() {
    if (!file || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);

    try {
      const body = new FormData();
      body.append("image", file);
      body.append("enable_gradcam", enableGradCam ? "true" : "false");
      if (partChoice !== "auto") body.append("input_type_hint", partChoice);

      const response = await fetch("/api/predict", { method: "POST", body });

      if (response.status === 422) {
        // Two different 422s: the quality gate rejected the image, or stage 1
        // declined to route it. Both carry a measured, user-facing message.
        const payload = (await response.json().catch(() => null)) as
          | { error?: { code?: string; message?: string; reasons?: string[] } }
          | null;
        setError({
          message: payload?.error?.message ?? "The image did not pass the quality checks.",
          reasons: payload?.error?.reasons ?? [],
          // A refusal is not a fault: the pipeline declined to guess rather
          // than attach a disease name to an image it could not classify.
          tone: "warning",
        });
        return;
      }

      const payload = (await response.json().catch(() => null)) as
        | { scan?: ScanWithUrls; error?: { message?: string } }
        | null;

      if (!response.ok || !payload?.scan) {
        setError({
          message:
            payload?.error?.message ??
            "The image could not be analysed. This is usually temporary - try again in a moment.",
        });
        return;
      }

      // Navigate to the stored scan so the result is durable, bookmarkable and
      // re-readable rather than living only in component state.
      router.push(`/scans/${payload.scan.id}`);
      router.refresh();
    } catch (caught) {
      setError({
        message:
          caught instanceof Error
            ? `The request could not be sent: ${caught.message}`
            : "The request could not be sent. Check your connection and try again.",
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      {error ? (
        <Alert tone={error.tone ?? (error.reasons?.length ? "warning" : "danger")} role="alert">
          <p className="font-medium">{error.message}</p>
          {error.reasons && error.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {error.reasons.map((reason) => (
                <li key={reason}>&bull; {reason}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      {/* ---------------- Dropzone ---------------- */}
      {!file ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "rounded-[var(--radius-card)] border-2 border-dashed p-8 text-center transition-colors",
            dragging ? "border-brand-500 bg-brand-50" : "border-ink-300 bg-white",
          )}
        >
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-brand-50 text-brand-700">
            <ImageUp className="size-6" aria-hidden="true" />
          </span>
          <p className="mt-4 text-sm font-medium text-ink-900">Drag an image here, or choose a file</p>
          <p className="mt-1.5 text-sm text-ink-600">
            A clear photo of a single citrus leaf or fruit, taken in daylight.
          </p>
          <p className="mt-1 text-xs text-ink-500">JPEG, PNG or WebP &middot; up to 10 MB</p>

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(",")}
            className="sr-only"
            aria-label="Choose a citrus image to analyse"
            onChange={(event) => accept(event.target.files?.[0] ?? null)}
          />

          <Button
            className="mt-5"
            size="lg"
            onClick={() => inputRef.current?.click()}
            leftIcon={<Upload className="size-4" aria-hidden="true" />}
          >
            Choose an image
          </Button>
        </div>
      ) : (
        <div className="rounded-[var(--radius-card)] border border-ink-200 bg-white p-4">
          <div className="flex gap-4">
            <div className="relative size-24 shrink-0 overflow-hidden rounded-lg border border-ink-200">
              {preview ? (
                // Blob URL from a local file, not remote content.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="The image you selected" className="size-full object-cover" />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink-900">{file.name}</p>
              <p className="mt-0.5 text-xs text-ink-500">
                {(file.size / 1024).toFixed(0)} KB &middot; {file.type}
              </p>
              <button
                type="button"
                onClick={() => accept(null)}
                disabled={pending}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-red-700 disabled:opacity-50"
              >
                <X className="size-3.5" aria-hidden="true" />
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Part selection ---------------- */}
      <div className="rounded-[var(--radius-card)] border border-ink-200 bg-white p-4">
        <p className="text-sm font-medium text-ink-900">What are you uploading?</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-600">
          The model decides this automatically and, when it is not sure, declines to guess rather than
          picking a disease model at random. Choosing Leaf or Fruit yourself runs that model explicitly.
        </p>
        <div
          className="mt-3 inline-flex rounded-lg border border-ink-200 p-0.5"
          role="radiogroup"
          aria-label="Input part"
        >
          {(
            [
              ["auto", "Detect automatically"],
              ["leaf", "Leaf"],
              ["fruit", "Fruit"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={partChoice === value}
              onClick={() => setPartChoice(value)}
              disabled={pending}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
                partChoice === value ? "bg-brand-700 text-white" : "text-ink-600 hover:bg-ink-100",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- Options ---------------- */}
      <div className="rounded-[var(--radius-card)] border border-ink-200 bg-white p-4">
        <label className="flex items-start gap-3">
          <Checkbox
            id="enable_gradcam"
            checked={enableGradCam}
            onChange={(event) => setEnableGradCam(event.target.checked)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink-900">Generate a Grad-CAM explanation</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-600">
              Highlights the image regions that drove the prediction. Strongly recommended: without it you only
              get a label, with it you can see where to look. Adds a second or two.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button
          size="lg"
          onClick={onSubmit}
          disabled={!file}
          loading={pending}
          leftIcon={pending ? undefined : <Camera className="size-4" aria-hidden="true" />}
          className="sm:w-auto"
        >
          {pending ? "Analysing…" : "Analyse this image"}
        </Button>

        <p className="text-xs text-ink-500">
          Results below {Math.round(minConfidence * 100)}% confidence are flagged as low confidence.
        </p>
      </div>

      {pending ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-[var(--radius-card)] border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900"
        >
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <div>
            <p className="font-medium">Analysing your image…</p>
            <p className="mt-0.5 text-brand-800">
              The model is checking image quality, identifying whether this is a leaf or a fruit, then
              running the matching disease model. The very first request after a restart also loads the
              model and can take noticeably longer.
            </p>
          </div>
        </div>
      ) : null}

      <div className="rounded-[var(--radius-card)] border border-ink-200 bg-ink-50 p-4">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-600">
          <Sparkles className="size-3.5" aria-hidden="true" />
          For the best result
        </h3>
        <ul className="mt-2.5 space-y-1.5 text-sm leading-relaxed text-ink-700">
          <li>Fill the frame with a single leaf or fruit.</li>
          <li>Use even, natural light &mdash; avoid harsh shadows and glare.</li>
          <li>Keep the camera steady and the subject in focus.</li>
          <li>
            For leaves, photograph both sides if you can; several of these diseases are easier to identify on the
            underside.
          </li>
        </ul>
      </div>
    </div>
  );
}
