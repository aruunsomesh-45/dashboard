"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { buildLink, LinkValidationError, PLACEMENTS, type Placement } from "@/lib/utmLinks";
import { Copy, Check, Link2, Archive, Info } from "lucide-react";

interface CampaignLink {
  id: string;
  link_code: string;
  placement: Placement;
  final_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string | null;
  utm_term: string | null;
  influencer_handle: string | null;
  label: string;
  created_at: string;
  archived_at: string | null;
}

const EMPTY = { placement: "instagram_story" as Placement, destination_url: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "", influencer_handle: "", label: "" };

export default function CampaignLinksPage() {
  const { currentWorkspace, currentBrand } = useAuth();
  const base = currentWorkspace && currentBrand ? `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/attribution` : null;
  const [form, setForm] = useState(EMPTY);
  const [links, setLinks] = useState<CampaignLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const data = await apiFetch<{ links: CampaignLink[] }>(`${base}/links/`);
      setLinks(data.links);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  // Live preview with a placeholder code; the server assigns the real, unique link code.
  const preview = useMemo(() => {
    if (!form.destination_url || !form.utm_campaign) return { url: null, problem: null };
    try {
      return { url: buildLink({ ...form }, "l_preview00").final_url.replace("l_preview00", "<link code>"), problem: null };
    } catch (e) {
      return { url: null, problem: e instanceof LinkValidationError ? e.message : "Invalid input" };
    }
  }, [form]);

  const preset = PLACEMENTS[form.placement];
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!base) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`${base}/links/`, { method: "POST", body: JSON.stringify(form) });
      setForm({ ...EMPTY, placement: form.placement, destination_url: form.destination_url });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function archive(id: string) {
    if (!base) return;
    try {
      await apiFetch(`${base}/links/${id}/archive/`, { method: "POST" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function copy(link: CampaignLink) {
    await navigator.clipboard.writeText(link.final_url);
    setCopied(link.id);
    setTimeout(() => setCopied(null), 1500);
  }

  const input = "w-full rounded-lg border border-ivory-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-forest-700";

  return (
    <DashboardShell>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold text-charcoal-900 tracking-tight flex items-center gap-2">
            <Link2 className="w-5 h-5" /> Campaign Links
          </h2>
          <p className="text-xs text-charcoal-500 mt-0.5">
            Build tagged links for Instagram, ads, email, influencers and WhatsApp. Every link gets its own code
            (<code>utm_id</code>), so visits and orders can be traced to the exact link. A link only shows results once it
            has received traffic.
          </p>
        </div>

        <form onSubmit={create} className="rounded-xl border border-ivory-300 bg-white p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="text-xs font-semibold text-charcoal-700 space-y-1">
              <span>Where will this link be used?</span>
              <select className={input} value={form.placement} onChange={set("placement")}>
                {Object.entries(PLACEMENTS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-charcoal-700 space-y-1">
              <span>Destination URL</span>
              <input className={input} placeholder="https://125east.in/products/chrome-buds" value={form.destination_url} onChange={set("destination_url")} required />
            </label>
            <label className="text-xs font-semibold text-charcoal-700 space-y-1">
              <span>Campaign name</span>
              <input className={input} placeholder="product_launch" value={form.utm_campaign} onChange={set("utm_campaign")} required />
            </label>
            {form.placement === "influencer" && (
              <label className="text-xs font-semibold text-charcoal-700 space-y-1">
                <span>Influencer handle</span>
                <input className={input} placeholder="@handle" value={form.influencer_handle} onChange={set("influencer_handle")} required />
              </label>
            )}
            <label className="text-xs font-semibold text-charcoal-700 space-y-1">
              <span>Source {preset.source && <em className="font-normal text-charcoal-500">(default: {preset.source})</em>}</span>
              <input className={input} placeholder={preset.source || "e.g. newsletter"} value={form.utm_source} onChange={set("utm_source")} />
            </label>
            <label className="text-xs font-semibold text-charcoal-700 space-y-1">
              <span>Medium {preset.medium && <em className="font-normal text-charcoal-500">(default: {preset.medium})</em>}</span>
              <input className={input} placeholder={preset.medium || "e.g. email"} value={form.utm_medium} onChange={set("utm_medium")} />
            </label>
            <label className="text-xs font-semibold text-charcoal-700 space-y-1">
              <span>Content {preset.content && <em className="font-normal text-charcoal-500">(default: {preset.content})</em>}</span>
              <input className={input} placeholder="story_link_01" value={form.utm_content} onChange={set("utm_content")} />
            </label>
            <label className="text-xs font-semibold text-charcoal-700 space-y-1">
              <span>Term (optional)</span>
              <input className={input} value={form.utm_term} onChange={set("utm_term")} />
            </label>
            <label className="text-xs font-semibold text-charcoal-700 space-y-1 md:col-span-2">
              <span>Internal label (optional)</span>
              <input className={input} placeholder="Diwali story, slide 2" value={form.label} onChange={set("label")} />
            </label>
          </div>

          <div className="rounded-lg bg-ivory-100 border border-ivory-300 px-3 py-2 text-xs font-mono break-all">
            {preview.url ?? <span className="text-charcoal-500 font-sans">{preview.problem ?? "Fill in the destination and campaign name to preview the link."}</span>}
          </div>
          {error && <p className="text-xs text-red-700">{error}</p>}
          <button type="submit" disabled={saving || !preview.url}
            className="px-3 py-1.5 rounded-lg bg-forest-900 text-ivory-100 text-xs font-semibold hover:bg-forest-800 disabled:opacity-60">
            {saving ? "Creating…" : "Create link"}
          </button>
        </form>

        <div className="rounded-xl border border-ivory-300 bg-white overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-ivory-100 text-charcoal-600">
              <tr>
                <th className="text-left px-3 py-2">Created</th>
                <th className="text-left px-3 py-2">Placement</th>
                <th className="text-left px-3 py-2">Source / medium</th>
                <th className="text-left px-3 py-2">Campaign / content</th>
                <th className="text-left px-3 py-2">Code</th>
                <th className="text-left px-3 py-2">Link</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {links.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-charcoal-500">
                  <Info className="w-4 h-4 inline mr-1" /> No campaign links yet.
                </td></tr>
              )}
              {links.map((l) => (
                <tr key={l.id} className={`border-t border-ivory-200 ${l.archived_at ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(l.created_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">{PLACEMENTS[l.placement]?.label ?? l.placement}{l.label && <div className="text-charcoal-500">{l.label}</div>}</td>
                  <td className="px-3 py-2">{l.utm_source} / {l.utm_medium}</td>
                  <td className="px-3 py-2">{l.utm_campaign}{l.utm_content && <div className="text-charcoal-500">{l.utm_content}</div>}</td>
                  <td className="px-3 py-2 font-mono">{l.link_code}</td>
                  <td className="px-3 py-2 font-mono max-w-xs truncate" title={l.final_url}>{l.final_url}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right space-x-2">
                    <button type="button" onClick={() => copy(l)} aria-label="Copy link" className="inline-flex items-center gap-1 text-forest-900">
                      {copied === l.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy
                    </button>
                    {!l.archived_at && (
                      <button type="button" onClick={() => archive(l.id)} aria-label="Archive link" className="inline-flex items-center gap-1 text-charcoal-500">
                        <Archive className="w-3.5 h-3.5" /> Archive
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardShell>
  );
}
