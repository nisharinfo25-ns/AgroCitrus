"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { createBrowserClient } from "@/lib/supabase/browser";
import { describeAuthError } from "@/lib/supabase/auth-errors";

/**
 * Set a new password after following an emailed reset link.
 *
 * Supabase delivers the link with the recovery token in the URL fragment, which
 * the browser client picks up (`detectSessionInUrl`). This component therefore
 * checks whether a recovery session actually exists rather than trusting the
 * URL alone.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Kept separate from `error` so a classified Supabase failure can carry an
  // operator-facing next step alongside its headline message.
  const [hint, setHint] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const supabase = createBrowserClient();

    // The auth client may still be parsing the URL fragment when this mounts,
    // so the session is read once immediately and again on the auth event.
    supabase.auth.getSession().then(({ data }) => {
      setHasRecoverySession(Boolean(data.session));
      setReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasRecoverySession(Boolean(session));
      setReady(true);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setHint(null);

    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setPending(true);
    try {
      const supabase = createBrowserClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        const described = describeAuthError(updateError);
      setError(described.message);
      setHint(described.hint);
        return;
      }
      setDone(true);
      // The recovery session is consumed; a full reload lands on a clean page.
      router.replace("/dashboard");
      router.refresh();
    } catch (caught) {
      const described = describeAuthError(caught);
      setError(described.message);
      setHint(described.hint);
    } finally {
      setPending(false);
    }
  }

  if (!ready) {
    return <div aria-busy="true" className="skeleton h-56 w-full" />;
  }

  if (!hasRecoverySession && !done) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">This link is no longer valid</h1>
        <Alert tone="warning" className="mt-5" role="alert">
          Password reset links expire quickly and can only be used once. Request a new one and open it from the
          same browser.
        </Alert>
        <Link
          href="/forgot-password"
          className="mt-5 inline-flex h-10 items-center rounded-lg bg-brand-700 px-4 text-sm font-medium text-white hover:bg-brand-800"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Password updated</h1>
        <Alert tone="success" className="mt-5" role="status">
          Your new password is active and you are signed in. Redirecting you to your dashboard&hellip;
        </Alert>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-900">Choose a new password</h1>
      <p className="mt-2 text-sm text-ink-600">
        This replaces the password on your CitrusGuard account. You will stay signed in afterwards.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {error ? (
          <Alert tone="danger" role="alert">
            <p>{error}</p>
            {hint ? <p className="mt-1.5 text-xs opacity-90">{hint}</p> : null}
          </Alert>
        ) : null}

        <Field label="New password" htmlFor="password" required hint="At least 8 characters.">
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

        <Field label="Confirm new password" htmlFor="confirm_password" required>
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
          leftIcon={<KeyRound className="size-4" aria-hidden="true" />}
        >
          Update password
        </Button>
      </form>
    </div>
  );
}