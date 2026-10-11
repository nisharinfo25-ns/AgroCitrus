"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Camera,
  LayoutDashboard,
  Leaf,
  LogOut,
  Menu,
  Settings,
  Shield,
  User,
  X,
} from "lucide-react";

import { createBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/cn";
import type { UserRole } from "@/types";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Exact match instead of prefix match (used by `/dashboard`). */
  exact?: boolean;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/detect", label: "Detect", icon: Camera },
  { href: "/scans", label: "My scans", icon: Leaf },
  { href: "/diseases", label: "Disease guide", icon: Shield },
  { href: "/profile", label: "Profile", icon: User },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * The signed-in application shell.
 *
 * The nav item for the admin dashboard is rendered from the role that came from
 * Postgres, never from a client-side claim. Hiding it is cosmetic only: every
 * admin route re-checks the role server-side.
 */
export function AppShell({
  email,
  fullName,
  role,
  children,
}: {
  email: string;
  fullName: string | null;
  role: UserRole;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const items = role === "admin" ? [...NAV, { href: "/admin", label: "Admin", icon: Shield }] : NAV;

  async function signOut() {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  const sidebar = (
    <nav aria-label="Application" className="flex h-full flex-col gap-1 p-3">
      {items.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              active ? "bg-brand-50 text-brand-800" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
            )}
          >
            <item.icon className="size-4.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{item.label}</span>
            {item.href === "/admin" ? (
              <span className="ml-auto rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-800">
                Admin
              </span>
            ) : null}
          </Link>
        );
      })}

      <div className="mt-auto border-t border-ink-200 pt-3">
        <div className="px-3 pb-2">
          <p className="truncate text-sm font-medium text-ink-900">{fullName || "CitrusGuard user"}</p>
          <p className="truncate text-xs text-ink-500">{email}</p>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={pending}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
        >
          <LogOut className="size-4.5 shrink-0" aria-hidden="true" />
          {pending ? "Signing outâ€¦" : "Sign out"}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh bg-ink-50">
      {/* Skip link target lives in the root layout. */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-ink-200 bg-white px-4 lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-ink-900">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-white">
            <Leaf className="size-4" aria-hidden="true" />
          </span>
          CitrusGuard
        </Link>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="app-nav"
          aria-label={open ? "Close navigation" : "Open navigation"}
          className="grid size-9 place-items-center rounded-lg text-ink-600 hover:bg-ink-100"
        >
          {open ? <Menu className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
        </button>
      </header>

      <div className="lg:grid lg:grid-cols-[16rem_1fr]">
        <aside className="sticky top-0 hidden h-dvh border-r border-ink-200 bg-white lg:block">{sidebar}</aside>

        {open ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-ink-900/40"
            />
            <div id="app-nav" className="relative h-full w-72 max-w-[85%] bg-white shadow-[var(--shadow-overlay)]">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="absolute right-2 top-2 grid size-9 place-items-center rounded-lg text-ink-600 hover:bg-ink-100"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
              {sidebar}
            </div>
          </div>
        ) : null}

        <main id="main-content" className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}