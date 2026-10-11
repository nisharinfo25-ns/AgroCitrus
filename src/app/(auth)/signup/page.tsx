import { Suspense } from "react";
import type { Metadata } from "next";

import { SignupForm } from "./signup-form";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Create a free CitrusGuard account to analyse citrus fruit and leaf images.",
};

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="skeleton h-64 w-full" />}>
      <SignupForm />
    </Suspense>
  );
}