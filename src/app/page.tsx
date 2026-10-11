import Link from "next/link";
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  FileImage,
  GitBranch,
  Layers,
  Leaf,
  ShieldAlert,
  Sparkles,
  ScanLine,
  TrendingUp,
} from "lucide-react";

import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { Badge } from "@/components/ui/badge";
import { getDiseaseEntry } from "@/content/diseases";

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-ink-50">
      <SiteHeader />

      <main id="main-content" className="flex-1">
        {/* ---------------- Hero ---------------- */}
        <section className="relative overflow-hidden border-b border-ink-200 bg-white">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-40 -top-40 size-[32rem] rounded-full bg-brand-100/60 blur-3xl"
          />
          <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <div className="max-w-3xl">
              <Badge tone="brand" icon={<Sparkles className="size-3.5" aria-hidden="true" />}>
                Explainable deep learning for citrus health
              </Badge>

              <h1 className="mt-5 text-4xl font-bold tracking-tight text-ink-900 sm:text-5xl lg:text-6xl">
                Spot citrus disease early, and
                <span className="text-brand-700"> see why</span> the model says so.
              </h1>

              <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-600">
                Upload a photo of a citrus fruit or leaf. A transfer-learning CNN classifies it, and Grad-CAM
                highlights the exact regions that drove the prediction &mdash; so you can judge the result instead
                of trusting it blindly.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link
                  href="/signup"
                  className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand-700 px-6 text-base font-medium text-white transition-colors hover:bg-brand-800"
                >
                  Analyse an image
                  <ArrowRight className="size-4.5" aria-hidden="true" />
                </Link>
                <Link
                  href="/diseases"
                  className="inline-flex h-12 items-center gap-2 rounded-xl border border-ink-300 bg-white px-6 text-base font-medium text-ink-800 transition-colors hover:bg-ink-50"
                >
                  Explore the disease guide
                </Link>
              </div>

              <p className="mt-5 flex items-start gap-2 text-sm text-ink-500">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                CitrusGuard is an advisory tool. It does not replace a laboratory diagnosis or a local
                agricultural extension officer.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------- How it works ---------------- */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              From photo to explanation in four steps
            </h2>
            <p className="mt-3 text-base leading-relaxed text-ink-600">
              The pipeline is the one described in the ML design: image, preprocessing, model, feature
              extraction, classification, prediction &mdash; with an image-quality gate in front of it.
            </p>
          </div>

          <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: FileImage,
                title: "1. Image quality check",
                body: "Blur, exposure and resolution are measured before anything reaches the model. A photo that cannot be classified is rejected with a reason, not guessed at.",
              },
              {
                icon: Layers,
                title: "2. Preprocessing",
                body: "The image is resized to the model's input shape and normalised exactly as it was during training, so inference sees what the model was fitted on.",
              },
              {
                icon: ScanLine,
                title: "3. Two-stage prediction",
                body: "A part classifier decides leaf or fruit, then the matching disease head runs. You get a real input type and a real class with calibrated probabilities.",
              },
              {
                icon: Sparkles,
                title: "4. Grad-CAM explanation",
                body: "The regions that most influenced the decision are overlaid on your photo, so a low-confidence result has something you can check.",
              },
            ].map((step) => (
              <li key={step.title} className="card p-5">
                <span className="grid size-10 place-items-center rounded-lg bg-brand-50 text-brand-700">
                  <step.icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-sm font-semibold text-ink-900">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ---------------- Features ---------------- */}
        <section className="border-y border-ink-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
              <div>
                <h2 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
                  Honest about what it does not know
                </h2>
                <p className="mt-3 text-base leading-relaxed text-ink-600">
                  Most disease apps show a confident label no matter what. CitrusGuard is built the other way
                  round: every limitation is surfaced in the interface.
                </p>

                <ul className="mt-7 space-y-4">
                  {[
                    {
                      title: "Low-confidence results are labelled as such",
                      body: "Below the model's confidence threshold, the result is presented as a suggestion with a warning &mdash; not as a finding.",
                    },
                    {
                      title: "Unmeasured metrics say so",
                      body: "If a number was never measured, the interface prints &ldquo;Not available&rdquo; instead of a zero or a placeholder.",
                    },
                    {
                      title: "Severity is only shown when it exists",
                      body: "Severity analysis requires its own trained head. This model has none, so the feature is explicitly unavailable rather than faked.",
                    },
                    {
                      title: "Every scan is kept and auditable",
                      body: "Original, processed and explanation images are stored against the exact model version that produced them.",
                    },
                  ].map((item) => (
                    <li key={item.title} className="flex gap-3">
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden="true" />
                      <div>
                        <p className="text-sm font-semibold text-ink-900">{item.title}</p>
                        <p className="mt-1 text-sm leading-relaxed text-ink-600">{item.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              {/* A static illustration of the explainer, not a fake screenshot. */}
              <div className="relative">
                <div className="card overflow-hidden p-0">
                  <div className="flex items-center gap-2 border-b border-ink-200 bg-ink-50 px-4 py-3">
                    <span className="size-2.5 rounded-full bg-red-400" />
                    <span className="size-2.5 rounded-full bg-amber-400" />
                    <span className="size-2.5 rounded-full bg-emerald-400" />
                    <span className="ml-2 font-mono text-xs text-ink-500">explanation overlay</span>
                  </div>
                  <div className="grid grid-cols-2 gap-px bg-ink-200">
                    <div className="grid aspect-square place-items-center bg-gradient-to-br from-brand-50 to-brand-100">
                      <Leaf className="size-16 text-brand-600/70" aria-hidden="true" />
                    </div>
                    <div className="relative grid aspect-square place-items-center bg-gradient-to-br from-amber-50 to-red-100">
                      <Leaf className="size-16 text-brand-700/50" aria-hidden="true" />
                      <div
                        aria-hidden="true"
                        className="absolute left-[38%] top-[42%] size-16 rounded-full bg-red-500/45 blur-md"
                      />
                      <div
                        aria-hidden="true"
                        className="absolute right-[26%] top-[28%] size-10 rounded-full bg-amber-500/40 blur-md"
                      />
                      <span className="absolute bottom-3 left-3 rounded-md bg-white/90 px-2 py-1 text-[10px] font-medium text-ink-700">
                        Grad-CAM
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2 p-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink-600">Predicted class</span>
                      <span className="font-semibold text-ink-900">Shown with its confidence</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink-600">Explanation</span>
                      <span className="font-semibold text-ink-900">Regions that drove it</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------- Classes ---------------- */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
                Classes the model was actually trained on
              </h2>
              <p className="mt-3 text-base leading-relaxed text-ink-600">
                These are the classes discovered in the published dataset, not a wish list. The disease guide
                documents each one, including which part of the plant it affects.
              </p>
            </div>
            <Link
              href="/diseases"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800"
            >
              Read the full guide
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>

          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {["black-spot", "canker", "greening", "melanose", "scab", "healthy"].map((slug) => {
              const entry = getDiseaseEntry(slug);
              if (!entry) return null;
              return (
                <li key={slug}>
                  <Link
                    href={`/diseases/${entry.slug}`}
                    className="card-interactive flex h-full flex-col p-5 no-underline"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold text-ink-900">{entry.displayName}</h3>
                      {entry.isHealthy ? (
                        <Badge tone="success">Healthy</Badge>
                      ) : (
                        <Badge tone="danger">Disease</Badge>
                      )}
                    </div>
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-ink-600">
                      {entry.shortDescription}
                    </p>
                    <p className="mt-3 text-xs font-medium text-ink-500">
                      Applies to {entry.appliesTo.join(" and ")}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        {/* ---------------- Architecture ---------------- */}
        <section className="border-t border-ink-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <h2 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              Built like a real system, not a demo
            </h2>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  icon: GitBranch,
                  title: "Next.js + TypeScript",
                  body: "App Router, server components, strict types and route handlers that enforce authorization server-side.",
                },
                {
                  icon: Layers,
                  title: "TensorFlow / Keras",
                  body: "Transfer-learning CNN heads, trained on CPU with a deterministic seed so a run is reproducible.",
                },
                {
                  icon: Camera,
                  title: "OpenCV + NumPy",
                  body: "Sharpness, exposure and resolution measured with OpenCV before the model is allowed to answer.",
                },
                {
                  icon: TrendingUp,
                  title: "Supabase",
                  body: "Row-level security on every scan, private storage buckets, and signed URLs minted only for authorised rows.",
                },
              ].map((item) => (
                <div key={item.title} className="card p-5">
                  <span className="grid size-10 place-items-center rounded-lg bg-ink-100 text-ink-700">
                    <item.icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold text-ink-900">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-600">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------- CTA ---------------- */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="card overflow-hidden bg-gradient-to-br from-brand-800 to-brand-950 p-8 text-center sm:p-12">
            <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Analyse your first citrus image
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-brand-100">
              Create a free account to run scans, keep your history, and read the full explanation behind every
              prediction.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                href="/signup"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-citrus-400 px-6 text-base font-semibold text-ink-900 transition-colors hover:bg-citrus-300"
              >
                Create an account
                <ArrowRight className="size-4.5" aria-hidden="true" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center rounded-xl border border-brand-400/40 px-6 text-base font-medium text-white transition-colors hover:bg-brand-700"
              >
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}