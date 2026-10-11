import { Suspense } from "react";
import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to CitrusGuard to analyse citrus fruit and leaf images.",
};

/**
 * `useSearchParams()` in the client form opts the subtree into dynamic
 * rendering, so the value is read behind a Suspense boundary to keep the page
 * statically prerenderable.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}

function FormSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading sign-in form">
      <div className="skeleton h-7 w-40" />
      <div className="skeleton mt-3 h-4 w-64" />
      <div className="skeleton mt-6 h-10 w-full" />
      <div className="skeleton mt-4 h-10 w-full" />
      <div className="skeleton mt-6 h-12 w-full" />
    </div>
  );
}