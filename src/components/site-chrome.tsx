import Link from "next/link";
import { Leaf, ShieldCheck } from "lucide-react";

/** The public marketing header. Server component - no interactivity needed. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-ink-200/70 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold text-ink-900">
          <span className="grid size-9 place-items-center rounded-lg bg-brand-700 text-white">
            <Leaf className="size-5" aria-hidden="true" />
          </span>
          <span className="text-lg tracking-tight">CitrusGuard</span>
        </Link>

        <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/diseases"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
          >
            Disease guide
          </Link>
          <Link
            href="/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-800"
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <div className="flex items-center gap-2 font-semibold text-ink-900">
              <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-white">
                <Leaf className="size-4" aria-hidden="true" />
              </span>
              CitrusGuard
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-600">
              Explainable citrus disease detection for fruit and leaf images, built on a transfer-learning
              CNN with Grad-CAM explanations.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 text-sm">
            <div>
              <h2 className="font-semibold text-ink-900">Product</h2>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="/diseases" className="text-ink-600 hover:text-brand-700">
                    Disease guide
                  </Link>
                </li>
                <li>
                  <Link href="/signup" className="text-ink-600 hover:text-brand-700">
                    Create an account
                  </Link>
                </li>
                <li>
                  <Link href="/login" className="text-ink-600 hover:text-brand-700">
                    Sign in
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h2 className="font-semibold text-ink-900">System</h2>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="/api/health" className="text-ink-600 hover:text-brand-700">
                    Health status
                  </Link>
                </li>
                <li>
                  <Link href="/dashboard" className="text-ink-600 hover:text-brand-700">
                    Dashboard
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-ink-200 pt-6">
          <p className="text-xs leading-relaxed text-ink-500">
            CitrusGuard produces research and advisory guidance, not a laboratory diagnosis. Always confirm a
            result with a local agricultural extension officer before acting on it.
          </p>
          <p className="mt-2 text-xs text-ink-400">
            Dataset licensed under CC BY 4.0 and attributed in the project README.
          </p>
        </div>
      </div>
    </footer>
  );
}