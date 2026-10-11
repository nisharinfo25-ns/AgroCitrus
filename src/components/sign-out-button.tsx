"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { createBrowserClient } from "@/lib/supabase/browser";

/**
 * Sign out.
 *
 * Calls the Supabase auth API directly rather than a Next route handler: the
 * session cookie is owned by `@supabase/ssr`, and going around the server
 * would leave a stale cookie that the middleware then has to clear anyway.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignOut() {
    setPending(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) throw signOutError;

      // Full navigation, not a client transition: the server components in the
      // shell still hold the old session and must be re-fetched.
      window.location.assign("/login");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `Could not sign out: ${caught.message}`
          : "Could not sign out. Check your connection and try again.",
      );
      setPending(false);
      router.refresh();
    }
  }

  return (
    <div>
      {error ? (
        <Alert tone="danger" className="mb-3" role="alert">
          {error}
        </Alert>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        onClick={onSignOut}
        loading={pending}
        leftIcon={<LogOut className="size-4" aria-hidden="true" />}
      >
        Sign out
      </Button>
    </div>
  );
}
