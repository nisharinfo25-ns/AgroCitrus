import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Camera, KeyRound, Settings, ShieldCheck } from "lucide-react";

import { ProfileForm } from "@/components/profile-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailRow } from "@/components/ui/empty-state";
import { requireUser } from "@/lib/auth";
import { getDashboardStats } from "@/lib/db/stats";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Profile",
  description: "Your account details and scan totals.",
};

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const { supabase, user, profile, role } = await requireUser();
  const stats = await getDashboardStats(supabase, user.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Profile</h1>
        <p className="mt-2 text-sm text-ink-600">Your account details and what you have analysed so far.</p>
      </header>

      <Card>
        <CardHeader
          title="Account"
          description="Some fields are managed elsewhere and cannot be changed here."
          action={
            role === "admin" ? (
              <Badge tone="brand" icon={<ShieldCheck className="size-3" aria-hidden="true" />}>
                Administrator
              </Badge>
            ) : null
          }
        />
        <ProfileForm
          userId={user.id}
          initialName={profile.full_name}
          email={profile.email}
          isAdmin={role === "admin"}
        />
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total scans" value={stats.total_scans} />
        <Stat label="Diseased results" value={stats.diseased_results} />
        <Stat label="Low confidence" value={stats.low_confidence_results} />
      </div>

      <Card>
        <CardHeader title="Account activity" />
        <dl>
          <DetailRow label="Member since">{formatDate(profile.created_at)}</DetailRow>
          <DetailRow label="Last updated">{formatDate(profile.updated_at)}</DetailRow>
          <DetailRow label="Email confirmed">
            {user.email_confirmed_at ? (
              <span className="text-brand-700">Yes &mdash; {formatDate(user.email_confirmed_at)}</span>
            ) : (
              <span className="text-amber-700">Not confirmed</span>
            )}
          </DetailRow>
          <DetailRow label="Last sign-in">
            {user.last_sign_in_at ? formatDate(user.last_sign_in_at, "time") : "Not available"}
          </DetailRow>
        </dl>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="Password" description="Managed by Supabase Auth." />
          <p className="text-sm leading-relaxed text-ink-600">
            Passwords are not stored or handled by this application. To change yours, request a reset link.
          </p>
          <Link
            href="/forgot-password"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            <KeyRound className="size-3.5" aria-hidden="true" />
            Send a password reset link
          </Link>
        </Card>

        <Card>
          <CardHeader title="Preferences" description="Display and detection options." />
          <p className="text-sm leading-relaxed text-ink-600">
            Confidence thresholds come from the deployed model rather than your account, so results stay
            comparable between users and reproducible.
          </p>
          <Link
            href="/settings"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            <Settings className="size-3.5" aria-hidden="true" />
            Open settings
          </Link>
        </Card>
      </div>

      <Card>
        <CardHeader title="Your data" />
        <p className="text-sm leading-relaxed text-ink-600">
          Every scan you run is private to your account. You can delete any scan, which removes both the record and
          its stored images, and deleting your account removes everything at once.
        </p>
        <Link
          href="/scans"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          <Camera className="size-3.5" aria-hidden="true" />
          Manage your scans
        </Link>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tabular-nums text-ink-900">{value.toLocaleString()}</p>
    </div>
  );
}
