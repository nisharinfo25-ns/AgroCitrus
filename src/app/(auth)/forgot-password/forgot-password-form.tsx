"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { createBrowserClient } from "@/lib/supabase/browser";
import { describeAuthError } from "@/lib/supabase/auth-errors";

/**
 * Request a password-reset email.
 *
 * The confirmation message is deliberately identical whether or not the address
 * exists, so this form cannot be used to enumerate registered accounts.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Kept separate from `error` so a classified Supabase failure can carry an
  // operator-facing next step alongside its headline message.
  const [hint, setHint] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setHint(null);
    setPending(true);

    try {
      const supabase = createBrowserClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (resetError) {
        // Configuration errors (e.g. SMTP not set up) are real and actionable,
        // so they are shown. Address-existence is not.
        const described = describeAuthError(resetError);
      setError(described.message);
      setHint(described.hint);
        return;
      }
      setSent(true);
    } catch (caught) {
      const described = describeAuthError(caught);
      setError(described.message);
      setHint(described.hint);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-900">Reset your password</h1>
      <p className="mt-2 text-sm text-ink-600">
        Enter the email address on your account and we will send you a link to set a new password.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {error ? (
          <Alert tone="danger" role="alert">
            <p>{error}</p>
            {hint ? <p className="mt-1.5 text-xs opacity-90">{hint}</p> : null}
          </Alert>
        ) : null}

        {sent ? (
          <Alert tone="success" title="Check your email" role="status">
            If an account exists for <strong>{email}</strong>, a reset link is on its way. The link expires
            after a short time.
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
            disabled={sent}
          />
        </Field>

        <Button
          type="submit"
          size="lg"
          loading={pending}
          className="w-full"
          disabled={sent}
          leftIcon={<Mail className="size-4" aria-hidden="true" />}
        >
          Send reset link
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-600">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}