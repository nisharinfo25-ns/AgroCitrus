import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/auth";

/**
 * Layout for every signed-in page.
 *
 * `getCurrentUser()` validates the session against Supabase on the server. The
 * middleware already redirects unauthenticated navigations; this is the second,
 * authoritative check at render time.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const authed = await getCurrentUser();

  if (!authed) {
    redirect("/login");
  }

  return (
    <AppShell
      email={authed.profile?.email || authed.user?.email || ""}
      fullName={authed.profile?.full_name ?? null}
      role={authed.role}
    >
      {children}
    </AppShell>
  );
}