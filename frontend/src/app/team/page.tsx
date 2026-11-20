"use client";

import React, { useState, useEffect } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabaseClient";
import { WorkspaceMember, UserRole } from "@/types/auth";
import { UserPlus, Copy, Check, Clock } from "lucide-react";

export default function TeamPage() {
  const { currentWorkspace } = useAuth();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("analyst");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generatedInviteUrl, setGeneratedInviteUrl] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwnerOrAdmin =
    currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  const fetchMembers = async () => {
    if (!currentWorkspace) return;
    setIsLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc("list_workspace_members", {
        p_workspace_id: currentWorkspace.id,
      });
      if (rpcError) throw rpcError;
      setMembers(
        (data || []).map((r: any) => ({
          id: r.id,
          role: r.role as UserRole,
          created_at: r.created_at,
          user: {
            id: r.user_id,
            email: r.email,
            first_name: r.first_name,
            last_name: r.last_name,
            mfa_enabled: r.mfa_enabled,
            created_at: r.created_at,
          },
        }))
      );
    } catch {
      setMembers([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMembers();
  }, [currentWorkspace]);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentWorkspace) return;
    setError(null);
    setIsSubmitting(true);

    try {
      const { data: res, error: rpcError } = await supabase.rpc("create_invite", {
        p_workspace_id: currentWorkspace.id,
        p_email: inviteEmail.trim(),
        p_role: inviteRole,
      });
      if (rpcError) {
        const m = rpcError.message || "";
        throw new Error(
          m.includes("already_member") ? "That person is already a member of this workspace."
          : m.includes("forbidden") ? "You don't have permission to invite with that role."
          : m.includes("invalid_email") ? "Enter a valid email address."
          : "Failed to generate invite."
        );
      }

      const fullUrl = `${window.location.origin}/invites/accept?token=${encodeURIComponent(res.token)}`;
      setGeneratedInviteUrl(fullUrl);
      setInviteEmail("");
    } catch (err: any) {
      setError(err.message || "Failed to generate invite.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-charcoal-900">
              Team & Role-Based Access (RBAC)
            </h2>
            <p className="text-xs text-charcoal-500 mt-1">
              Manage workspace members and single-use 72-hour team invitations.
            </p>
          </div>

          {isOwnerOrAdmin && (
            <button
              onClick={() => {
                setGeneratedInviteUrl(null);
                setError(null);
                setShowInviteModal(true);
              }}
              className="px-4 py-2 rounded-lg bg-terracotta-500 hover:bg-terracotta-600 text-white font-medium text-xs flex items-center space-x-2 shadow-sm transition-colors"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Invite Teammate</span>
            </button>
          )}
        </div>

        {/* Members Table */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-ivory-200">
            <h3 className="text-xs font-semibold text-charcoal-800 uppercase tracking-wider">
              Active Workspace Members ({members.length})
            </h3>
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-xs text-charcoal-500">
              Loading members...
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="bg-ivory-50 text-charcoal-600 border-b border-ivory-200">
                <tr>
                  <th className="py-3 px-6 font-semibold">User</th>
                  <th className="py-3 px-6 font-semibold">Role</th>
                  <th className="py-3 px-6 font-semibold">MFA Status</th>
                  <th className="py-3 px-6 font-semibold">Joined Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ivory-200">
                {members.map((m) => (
                  <tr key={m.id} className="hover:bg-ivory-50/50">
                    <td className="py-3.5 px-6">
                      <div className="font-medium text-charcoal-900">
                        {m.user.first_name || m.user.last_name
                          ? `${m.user.first_name} ${m.user.last_name}`
                          : m.user.email}
                      </div>
                      <div className="text-[11px] text-charcoal-500">{m.user.email}</div>
                    </td>
                    <td className="py-3.5 px-6">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                          m.role === "owner"
                            ? "bg-amber-100 text-amber-800"
                            : m.role === "admin"
                            ? "bg-purple-100 text-purple-800"
                            : m.role === "analyst"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {m.role}
                      </span>
                    </td>
                    <td className="py-3.5 px-6">
                      {m.user.mfa_enabled ? (
                        <span className="inline-flex items-center space-x-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded text-[11px]">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                          <span>Protected</span>
                        </span>
                      ) : (
                        <span className="text-charcoal-400 text-[11px]">Not enabled</span>
                      )}
                    </td>
                    <td className="py-3.5 px-6 text-charcoal-500 font-mono text-[11px]">
                      {new Date(m.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Invite Teammate Modal */}
        {showInviteModal && (
          <div className="fixed inset-0 z-50 bg-charcoal-900/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-ivory-300">
              <h3 className="text-base font-semibold text-charcoal-900 mb-1">
                Invite Teammate to {currentWorkspace?.name}
              </h3>
              <p className="text-xs text-charcoal-500 mb-4">
                Generates a single-use 72-hour invite token bound to your workspace.
              </p>

              {error && (
                <div className="mb-4 p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {error}
                </div>
              )}

              {!generatedInviteUrl ? (
                <form onSubmit={handleSendInvite} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-charcoal-700 mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      required
                      placeholder="colleague@example.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-ivory-300 focus:outline-none focus:border-terracotta-500 bg-ivory-50 text-charcoal-900"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-charcoal-700 mb-1">
                      Access Role
                    </label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as UserRole)}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-ivory-300 focus:outline-none focus:border-terracotta-500 bg-ivory-50 text-charcoal-900"
                    >
                      <option value="analyst">Analyst (Full analytics view & exports)</option>
                      <option value="admin">Admin (Manage integrations & members)</option>
                      <option value="viewer">Viewer (Read-only)</option>
                      {currentWorkspace?.role === "owner" && (
                        <option value="owner">Owner (Full control incl. billing)</option>
                      )}
                    </select>
                  </div>

                  <div className="flex justify-end space-x-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowInviteModal(false)}
                      className="px-3 py-1.5 rounded-md text-xs font-medium text-charcoal-500 hover:bg-ivory-200"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="px-4 py-1.5 rounded-md text-xs font-medium bg-terracotta-500 hover:bg-terracotta-600 text-white disabled:opacity-50"
                    >
                      {isSubmitting ? "Generating..." : "Generate Invite Link"}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="space-y-4">
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs">
                    Invite link successfully generated! Send this single-use link to your colleague:
                  </div>

                  <div className="p-2.5 rounded-lg bg-ivory-200 border border-ivory-300 font-mono text-[11px] text-charcoal-800 break-all select-all flex items-center justify-between">
                    <span>{generatedInviteUrl}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(generatedInviteUrl);
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 2000);
                      }}
                      className="ml-2 p-1.5 rounded bg-white border border-ivory-300 hover:text-terracotta-500 flex-shrink-0"
                    >
                      {copiedLink ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>

                  <div className="flex items-center space-x-1.5 text-charcoal-500 text-[11px]">
                    <Clock className="w-3.5 h-3.5 text-terracotta-500" />
                    <span>Expires in 72 hours. Single-use only.</span>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => {
                        setShowInviteModal(false);
                        setGeneratedInviteUrl(null);
                      }}
                      className="px-4 py-2 rounded-lg bg-forest-800 hover:bg-forest-900 text-white text-xs font-medium"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
