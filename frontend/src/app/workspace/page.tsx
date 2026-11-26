"use client";

import React, { useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";

/** Same key AuthContext uses to remember the selected workspace and brand (a UI preference only). */
const PREF_KEY = "dashboard:selection";
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD"];

function selectWorkspace(slug: string) {
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify({ ws: slug }));
  } catch {
    /* storage unavailable: the default workspace is used on the next visit */
  }
}

export default function WorkspacePage() {
  const { currentWorkspace, workspaces, refreshAuth } = useAuth();
  const isOwner = currentWorkspace?.role === "owner";
  const canManage = isOwner || currentWorkspace?.role === "admin";

  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState(currentWorkspace?.name ?? "");
  const [brandName, setBrandName] = useState("");
  const [brandCurrency, setBrandCurrency] = useState("INR");
  const [brandTz, setBrandTz] = useState("Asia/Kolkata");
  const [confirmSlug, setConfirmSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(ok);
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const createWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const created = await apiFetch<{ slug: string }>("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      selectWorkspace(created.slug);
      window.location.href = "/dashboard";
    }, "Workspace created.");
  };

  const rename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentWorkspace) return;
    void run(async () => {
      await apiFetch(`/api/w/${currentWorkspace.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameTo }),
      });
      await refreshAuth();
    }, "Workspace renamed.");
  };

  const addBrand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentWorkspace) return;
    void run(async () => {
      await apiFetch(`/api/w/${currentWorkspace.slug}/brands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: brandName, currency: brandCurrency, timezone: brandTz }),
      });
      setBrandName("");
      await refreshAuth();
    }, "Brand added.");
  };

  const deleteWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentWorkspace) return;
    if (!window.confirm(`Permanently delete ${currentWorkspace.name} and all of its data? This cannot be undone.`)) return;
    const deletedSlug = currentWorkspace.slug;
    void run(async () => {
      await apiFetch(`/api/w/${deletedSlug}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: confirmSlug }),
      });
      const next = workspaces.find((w) => w.slug !== deletedSlug);
      if (next) selectWorkspace(next.slug);
      else {
        try {
          window.localStorage.removeItem(PREF_KEY);
        } catch {
          /* ignore */
        }
      }
      window.location.href = "/dashboard";
    }, "Workspace deleted.");
  };

  const input = "w-full border border-ivory-300 rounded-lg px-3 py-2 text-sm bg-white";
  const button =
    "px-4 py-2 rounded-lg bg-charcoal-900 text-white text-xs font-semibold disabled:opacity-50 hover:bg-charcoal-800";
  const card = "bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4";

  return (
    <DashboardShell>
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-xl font-semibold text-charcoal-900">Workspace</h1>
          <p className="text-xs text-charcoal-500">
            Create and manage workspaces, their brands, and what happens to their data.
          </p>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">{error}</div>}
        {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">{notice}</div>}

        <form onSubmit={createWorkspace} className={card}>
          <h2 className="text-sm font-semibold text-charcoal-900">Create a new workspace</h2>
          <p className="text-xs text-charcoal-500">A separate workspace with its own brand, members and data. You own it.</p>
          <div className="flex gap-2">
            <input className={input} placeholder="Workspace name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />
            <button className={button} disabled={busy || newName.trim().length < 2}>Create</button>
          </div>
        </form>

        {currentWorkspace && (
          <div className={card}>
            <h2 className="text-sm font-semibold text-charcoal-900">Current workspace: {currentWorkspace.name}</h2>
            <p className="text-xs text-charcoal-500">Your role: {currentWorkspace.role}</p>
            {canManage ? (
              <form onSubmit={rename} className="flex gap-2">
                <input className={input} value={renameTo} onChange={(e) => setRenameTo(e.target.value)} maxLength={120} aria-label="New workspace name" />
                <button className={button} disabled={busy || renameTo.trim().length < 2}>Rename</button>
              </form>
            ) : (
              <p className="text-xs text-charcoal-500">Only owners and admins can rename the workspace.</p>
            )}
          </div>
        )}

        {currentWorkspace && (
          <div className={card}>
            <h2 className="text-sm font-semibold text-charcoal-900">Brands ({currentWorkspace.brands.length})</h2>
            <ul className="text-xs text-charcoal-700 divide-y divide-ivory-200">
              {currentWorkspace.brands.map((b) => (
                <li key={b.id} className="py-2 flex justify-between">
                  <span className="font-medium">{b.name}</span>
                  <span className="text-charcoal-500">
                    {b.currency} · {b.timezone}
                  </span>
                </li>
              ))}
            </ul>
            {canManage && (
              <form onSubmit={addBrand} className="grid grid-cols-1 md:grid-cols-4 gap-2 pt-2">
                <input className={input} placeholder="Brand name" value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={120} aria-label="Brand name" />
                <select className={input} value={brandCurrency} onChange={(e) => setBrandCurrency(e.target.value)} aria-label="Currency">
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <input className={input} value={brandTz} onChange={(e) => setBrandTz(e.target.value)} aria-label="Timezone" />
                <button className={button} disabled={busy || brandName.trim().length < 2}>Add brand</button>
              </form>
            )}
            <p className="text-[11px] text-charcoal-500">New brands count against your plan’s brand limit.</p>
          </div>
        )}

        {currentWorkspace && isOwner && (
          <form onSubmit={deleteWorkspace} className="bg-white rounded-xl border border-red-200 shadow-sm p-6 space-y-3">
            <h2 className="text-sm font-semibold text-red-800">Delete this workspace</h2>
            <p className="text-xs text-charcoal-600">
              Removes the workspace with all its brands, members, orders, ad data and history. Only owners can do this.
              To confirm, type <span className="font-mono">{currentWorkspace.slug}</span> below.
            </p>
            <div className="flex gap-2">
              <input className={input} value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} aria-label="Type the workspace slug to confirm" />
              <button className="px-4 py-2 rounded-lg bg-red-700 text-white text-xs font-semibold disabled:opacity-50" disabled={busy || confirmSlug !== currentWorkspace.slug}>
                Delete workspace
              </button>
            </div>
          </form>
        )}
      </div>
    </DashboardShell>
  );
}
