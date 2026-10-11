"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Loader2, Save } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Edit the signed-in user's display name.
 *
 * Writes through the RLS-scoped client, so the `profiles_update_own` policy is
 * the only thing standing between this form and someone editing another
 * account. There is deliberately no client-side role or email field: those are
 * not the user's to set, and offering the control would imply it works.
 */
export function ProfileForm({
  userId,
  initialName,
  email,
  isAdmin,
}: {
  userId: string;
  initialName: string | null;
  email: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = name.trim();
  const unchanged = trimmed === (initialName ?? "");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // `null` clears the name; an empty string would store an empty name.
        body: JSON.stringify({ full_name: trimmed === "" ? null : trimmed }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "Your profile could not be saved.");
        return;
      }

      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `The request could not be sent: ${caught.message}`
          : "The request could not be sent. Check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {saved && !error ? (
        <Alert tone="success" role="status">
          Your profile has been saved.
        </Alert>
      ) : null}

      <div>
        <label htmlFor="full_name" className="block text-sm font-medium text-ink-800">
          Display name
        </label>
        <Input
          id="full_name"
          name="full_name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          maxLength={120}
          placeholder="How your name appears in the app"
          className="mt-1.5"
          autoComplete="name"
        />
        <p className="mt-1.5 text-xs text-ink-500">
          Optional. This is only shown to you &mdash; scans are not shared between accounts.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <span className="block text-sm font-medium text-ink-800">Email</span>
          <p className="mt-1.5 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-600">
            {email}
          </p>
          <p className="mt-1.5 text-xs text-ink-500">
            Managed by Supabase Auth. Changing it requires a verification round-trip, so it is not editable here.
          </p>
        </div>

        <div>
          <span className="block text-sm font-medium text-ink-800">Role</span>
          <p className="mt-1.5 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-600">
            {isAdmin ? "Administrator" : "User"}
          </p>
          <p className="mt-1.5 text-xs text-ink-500">
            Roles are set by an administrator or directly in PostgreSQL. A user cannot promote themselves.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-ink-100 pt-4">
        <Button type="submit" loading={pending} disabled={unchanged} leftIcon={<Save className="size-4" aria-hidden="true" />}>
          Save changes
        </Button>
        {unchanged && !saved ? (
          <p className="text-xs text-ink-500">No changes to save.</p>
        ) : null}
        {pending ? (
          <span className="flex items-center gap-1.5 text-xs text-ink-500">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            Saving
          </span>
        ) : null}
      </div>

      <p className="text-xs text-ink-400">
        Account reference <code className="font-mono">{userId}</code>
      </p>
    </form>
  );
}
