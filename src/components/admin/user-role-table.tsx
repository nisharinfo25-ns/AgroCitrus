"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Shield, ShieldOff, Trash2 } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

export interface AdminUserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: "admin" | "user";
  created_at: string;
  updated_at: string;
}

/**
 * User administration.
 *
 * The destructive actions are two-step inline confirmations, and the self row
 * is rendered without controls. That is not a UI nicety - the API refuses both
 * (an admin cannot change their own role, and the last admin cannot be
 * demoted), so showing a button that always fails would be misleading.
 */
export function UserRoleTable({
  users,
  currentUserId,
}: {
  users: AdminUserRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(id: string, method: "PATCH" | "DELETE", body?: object) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        setError(payload?.error?.message ?? `The request failed (status ${response.status}).`);
        return false;
      }
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `The request could not be sent: ${caught.message}`
          : "The request could not be sent.",
      );
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(user: AdminUserRow) {
    const next = user.role === "admin" ? "user" : "admin";
    const done = await call(user.id, "PATCH", { role: next });
    if (done) {
      setNotice(
        `${user.email} is now ${next === "admin" ? "an administrator" : "a standard user"}.`,
      );
      setConfirmDelete(null);
      router.refresh();
    }
  }

  async function deleteUser(user: AdminUserRow) {
    const done = await call(user.id, "DELETE");
    if (done) {
      setNotice(`${user.email} and all of their scans have been deleted.`);
      setConfirmDelete(null);
      router.refresh();
    }
  }

  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" role="status">
          {notice}
        </Alert>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full min-w-[42rem] text-left text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th scope="col" className="px-3 py-2.5 font-medium">User</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Role</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Joined</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              return (
                <tr key={user.id}>
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-ink-900">
                      {user.full_name?.trim() || user.email}
                    </p>
                    <p className="text-xs text-ink-500">
                      {user.full_name?.trim() ? user.email : ""}
                      {isSelf ? <span className="ml-1.5 text-brand-700">(you)</span> : null}
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={user.role === "admin" ? "brand" : "neutral"}>
                      {user.role}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-600">
                    {formatDate(user.created_at)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {isSelf ? (
                      <span className="text-xs text-ink-400">
                        You cannot change your own role or delete your own account here.
                      </span>
                    ) : confirmDelete === user.id ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="danger"
                          loading={busyId === user.id}
                          onClick={() => deleteUser(user)}
                        >
                          Delete permanently
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyId === user.id}
                          onClick={() => setConfirmDelete(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyId === user.id}
                          onClick={() => changeRole(user)}
                          leftIcon={
                            user.role === "admin" ? (
                              <ShieldOff className="size-3" aria-hidden="true" />
                            ) : (
                              <Shield className="size-3" aria-hidden="true" />
                            )
                          }
                        >
                          {user.role === "admin" ? "Demote" : "Promote"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(user.id)}
                          aria-label={`Delete ${user.email}`}
                          leftIcon={<Trash2 className="size-3" aria-hidden="true" />}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-ink-500">
        Deleting a user removes their profile and every scan row, and deletes their stored images from private
        storage. It cannot be undone. The server refuses to demote the last remaining administrator, and
        refuses to let an administrator change their own role.
      </p>
    </div>
  );
}
