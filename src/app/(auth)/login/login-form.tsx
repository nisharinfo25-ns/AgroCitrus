"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { createBrowserClient } from "@/lib/supabase/browser";
import { describeAuthError, type AuthErrorDescription } from "@/lib/supabase/auth-errors";

/**
 * Sign in with email + password.
 *
 * Supabase errors are classified rather than shown raw, because a rejected
 * project key and a wrong password arrive as equally terse messages and need
 * opposite responses. See `describeAuthError`. Nothing is swallowed: a failure
 * always produces a visible message rather than a silent no-op.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<AuthErrorDescription | null>(null);
  const [pending, setPending] = useState(false);

  const next = params.get("next");
  const urlError = params.get("error");

  const banner = urlError ? describeUrlError(urlError) : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const supabase = createBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError) {
        setError(describeAuthError(signInError));
        return;
      }

      // Verify the session really exists before navigating. A 200 from the
      // token endpoint is not on its own proof that a usable session was
      // established - `data.session` is. Without this check a partial success
      // would redirect to /dashboard, where the guards bounce straight back to
      // /login and the user sees a flash with no explanation.
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session) {
        setError({
          kind: "unknown",
          message: "Signed in, but the session could not be established.",
          hint:
            "Supabase accepted the credentials but no session was returned, so the app cannot " +
            "verify you are signed in. Check that cookies are allowed for this site, then try again.",
        });
        return;
      }

      // Full navigation so the server layout re-reads the session cookie.
      router.replace(safeNext(next));
      router.refresh();
    } catch (caught) {
      setError(describeAuthError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-900">Welcome back</h1>
      <p className="mt-2 text-sm text-ink-600">Sign in to analyse new images and review your scan history.</p>

      {banner ? (
        <Alert tone="warning" className="mt-5" role="alert">
          {banner}
        </Alert>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {error ? (
          <Alert tone="danger" role="alert">
            <p>{error.message}</p>
            {error.hint ? <p className="mt-1.5 text-xs opacity-90">{error.hint}</p> : null}
          </Alert>
        ) : null}

        <Field label="Email address" htmlFor="email" required>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          required
          hint={
            <Link href="/forgot-password" className="font-medium text-brand-700 hover:text-brand-800">
              Forgot your password?
            </Link>
          }
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Button type="submit" size="lg" loading={pending} className="w-full" leftIcon={<LogIn className="size-4" aria-hidden="true" />}>
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-600">
        Don&apos;t have an account?{" "}
        <Link
          href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
          className="font-medium text-brand-700 hover:text-brand-800"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}

/** Only same-origin relative paths may be used as a post-login destination. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/dashboard";
  return next;
}

function describeUrlError(code: string): string {
  switch (code) {
    case "not_configured":
      return "This app is not configured yet. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.";
    case "forbidden":
      return "That page requires an administrator account.";
    case "missing_code":
      return "The sign-in link did not include a code. Request a new link and try again.";
    case "invalid_code":
      return "That sign-in link has expired or was already used. Request a new one.";
    default:
      return "Sign in did not complete. Please try again.";
  }
}