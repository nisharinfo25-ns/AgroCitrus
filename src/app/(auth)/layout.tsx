import Link from "next/link";
import { Leaf } from "lucide-react";

import { PageNotice } from "@/components/ui/alert";

/** Split layout for the signed-out pages: form on the right, pitch on the left. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-gradient-to-br from-brand-800 to-brand-950 p-10 text-white lg:flex">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
          <span className="grid size-9 place-items-center rounded-lg bg-white/15">
            <Leaf className="size-5" aria-hidden="true" />
          </span>
          CitrusGuard
        </Link>

        <div className="max-w-sm">
          <h1 className="text-3xl font-bold tracking-tight">
            Explainable citrus disease detection for fruit and leaves.
          </h1>
          <p className="mt-4 leading-relaxed text-brand-100">
            Every prediction comes with the image regions that influenced it, an explicit confidence figure, and
            a plain statement of what the model is not able to tell you.
          </p>
        </div>

        <p className="text-xs leading-relaxed text-brand-200/80">
          Advisory tool only. Results are not a laboratory diagnosis. Confirm with a local agricultural
          extension officer before acting.
        </p>
      </aside>

      <main id="main-content" className="flex flex-col px-4 py-10 sm:px-8 lg:px-12">
        <div className="lg:hidden">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink-900">
            <span className="grid size-9 place-items-center rounded-lg bg-brand-700 text-white">
              <Leaf className="size-5" aria-hidden="true" />
            </span>
            CitrusGuard
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-sm">{children}</div>
        </div>

        <div className="mt-6">
          <PageNotice tone="info" title="Trouble signing in?">
            Read the message above the form first - it names the cause. If it mentions the API key, the
            public key in <code className="font-mono text-xs">.env.local</code> is present but was
            rejected, so no password will work until it is replaced with the current anon key from
            Supabase. After editing <code className="font-mono text-xs">.env.local</code>, restart the
            server: <code className="font-mono text-xs">NEXT_PUBLIC_*</code> values are inlined at build
            time, so the change has no effect until then.
          </PageNotice>
        </div>
      </main>
    </div>
  );
}