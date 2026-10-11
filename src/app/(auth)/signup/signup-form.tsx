"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { createBrowserClient } from "@/lib/supabase/browser";
import { describeAuthError } from "@/lib/supabase/auth-errors";

/**
 * Create an account.
 *
 * New users are always created with the `user` role. The role column is set by
 * the `handle_new_user()` trigger and the RLS policy on `profiles` refuses any
 * update that changes it, so there is no "sign up as admin" path â€” promotion is
 * an explicit, audited action in the admin panel.
 */
export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Kept separate from `error` so a client-side validation message (a plain
  // string) and a classified Supabase failure can share one alert slot.
  const [hint, setHint] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setHint(null);
    setNotice(null);

    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }

    setPending(true);
    try {
      const supabase = createBrowserClient();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          // `full_name` is read by the handle_new_user() trigger to seed the
          // profile row.
          data: { full_name: fullName.trim() || null },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (signUpError) {
        const described = describeAuthError(signUpError);
        setError(described.message);
        setHint(described.hint);
        return;
      }

      if (data.session) {
        // Email confirmation is disabled: the session exists immediately.
        router.replace(safeNext(params.get("next")));
        router.refresh();
        return;
      }

      setNotice(
        "Account created. Check your inbox for the confirmation email, then sign in to continue.",
      );
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
      <h1 className="text-2xl font-bold tracking-tight text-ink-900">Create your account</h1>
      <p className="mt-2 text-sm text-ink-600">
        Free to use. Your scans stay private and only visible to you.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {error ? (
          <Alert tone="danger" role="alert">
            <p>{error}</p>
            {hint ? <p className="mt-1.5 text-xs opacity-90">{hint}</p> : null}
          </Alert>
        ) : null}
        {notice ? (
          <Alert tone="success" role="status">
            {notice}
          </Alert>
        ) : null}

        <Field label="Full name" htmlFor="full_name" hint="Optional. Used to label your scans.">
          <Input
            id="full_name"
            name="full_name"
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Jane Okafor"
          />
        </Field>

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

        <Field label="Password" htmlFor="password" required hint="At least 8 characters.">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Field label="Confirm password" htmlFor="confirm_password" required>
          <Input
            id="confirm_password"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        <Button
          type="submit"
          size="lg"
          loading={pending}
          className="w-full"
          leftIcon={<UserPlus className="size-4" aria-hidden="true" />}
        >
          Create account
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-600">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
          Sign in
        </Link>
      </p>
    </div>
  );
}

function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/dashboard";
  return next;
}