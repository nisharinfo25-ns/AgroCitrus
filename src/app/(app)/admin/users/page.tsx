import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { UserRoleTable, type AdminUserRow } from "@/components/admin/user-role-table";
import { PageNotice } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Users",
  description: "Manage user accounts and roles.",
};

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const { supabase, user } = await requireAdmin();

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, created_at, updated_at")
    .order("created_at", { ascending: false });

  const users = ((data ?? []) as AdminUserRow[]).filter((row) => typeof row.id === "string");

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to admin
        </Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink-900">Users</h1>
        <p className="mt-2 text-sm text-ink-600">
          {users.length === 1 ? "1 registered account" : `${users.length} registered accounts`}. Roles are
          enforced server-side; the buttons below mirror what the API will actually accept.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Accounts"
          description="Promote, demote or delete."
        />
        {error ? (
          <PageNotice tone="danger" title="The user list could not be loaded">
            {error.message}
          </PageNotice>
        ) : users.length === 0 ? (
          <p className="text-sm text-ink-600">No accounts have registered yet.</p>
        ) : (
          <UserRoleTable users={users} currentUserId={user.id} />
        )}
      </Card>
    </div>
  );
}