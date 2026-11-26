import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionContext, TenantContext } from "@/lib/serverAuth";
import { RouteError } from "@/lib/routeError";
import { buildLink, LinkValidationError, newLinkCode, PLACEMENTS, type LinkInput } from "@/lib/utmLinks";

/**
 * /w/:slug/b/:brandId/attribution/*
 *   GET  attribution/links                 list campaign links (newest first)
 *   POST attribution/links                 create a link (owner/admin/analyst)
 *   POST attribution/links/:id/archive     archive (links are never edited: history is kept)
 *   GET  attribution/report?from&to&model&version   campaign performance (verified revenue only)
 *   GET  attribution/meta?from&to          Meta platform-reported vs internally attributed
 */
const LINK_WRITERS = new Set(["owner", "admin", "analyst"]);
const MODELS = new Set(["first_touch", "last_touch", "last_non_direct", "linear"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(req: NextRequest, name: string, fallbackDaysAgo: number): string {
  const v = req.nextUrl.searchParams.get(name);
  if (v) {
    if (!DATE.test(v) || Number.isNaN(Date.parse(v))) throw new RouteError(400, `${name} must be YYYY-MM-DD`);
    return v;
  }
  return new Date(Date.now() - fallbackDaysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function storeHosts(admin: SupabaseClient, brandId: string): Promise<string[]> {
  const { data } = await admin.from("attribution_site").select("allowed_origins").eq("brand_id", brandId).maybeSingle();
  return ((data?.allowed_origins as string[] | undefined) ?? [])
    .map((o) => {
      try {
        return new URL(o).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export async function handleAttributionRoute(
  admin: SupabaseClient,
  tenant: TenantContext,
  session: SessionContext,
  req: NextRequest,
  action: string,
  method: string,
): Promise<unknown> {
  const brandId = tenant.brand!.id;
  const sub = action.slice("attribution/".length);

  if (sub === "links" && method === "GET") {
    const { data, error } = await admin.from("attribution_link")
      .select("id, link_code, placement, destination_url, final_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, influencer_handle, label, created_at, archived_at")
      .eq("brand_id", brandId).order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    return { links: data ?? [], placements: PLACEMENTS };
  }

  if (sub === "links" && method === "POST") {
    if (!LINK_WRITERS.has(tenant.role)) throw new RouteError(403, "Your role cannot create campaign links");
    let body: LinkInput;
    try {
      body = await req.json();
    } catch {
      throw new RouteError(400, "Malformed JSON body");
    }
    let built;
    try {
      built = buildLink(body, newLinkCode(), await storeHosts(admin, brandId));
    } catch (e) {
      if (e instanceof LinkValidationError) throw new RouteError(400, e.message);
      throw e;
    }
    // A unique link_code collision is astronomically unlikely; retry once with a fresh code.
    for (let attempt = 0; attempt < 2; attempt++) {
      const code = attempt === 0 ? new URL(built.final_url).searchParams.get("utm_id")! : newLinkCode();
      const final = new URL(built.final_url);
      final.searchParams.set("utm_id", code);
      const { data, error } = await admin.from("attribution_link").insert({
        ...built, final_url: final.toString(), link_code: code,
        workspace_id: tenant.workspaceId, brand_id: brandId, created_by: session.userId,
      }).select("id, link_code, final_url, created_at").single();
      if (!error) return { link: data };
      if ((error as { code?: string }).code !== "23505") throw new Error(error.message);
    }
    throw new RouteError(409, "Could not allocate a unique link code; please retry");
  }

  const archive = sub.match(/^links\/([0-9a-f-]{36})\/archive$/i);
  if (archive && method === "POST") {
    if (!LINK_WRITERS.has(tenant.role)) throw new RouteError(403, "Your role cannot archive campaign links");
    const { data, error } = await admin.from("attribution_link").update({ archived_at: new Date().toISOString() })
      .eq("id", archive[1]).eq("brand_id", brandId).is("archived_at", null).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new RouteError(404, "Link not found or already archived");
    return { archived: data.id };
  }

  if (sub === "report" && method === "GET") {
    const from = dateParam(req, "from", 30);
    const to = dateParam(req, "to", 0);
    const model = req.nextUrl.searchParams.get("model") ?? "";
    const version = Number(req.nextUrl.searchParams.get("version") ?? "");
    let m = model;
    let v = version;
    if (!m || !Number.isInteger(v) || v < 1) {
      const { data: s } = await admin.from("attribution_settings").select("default_model, default_version").eq("brand_id", brandId).maybeSingle();
      m = m || s?.default_model || "last_non_direct";
      v = Number.isInteger(v) && v >= 1 ? v : s?.default_version ?? 1;
    }
    if (!MODELS.has(m)) throw new RouteError(400, "model must be first_touch, last_touch, last_non_direct or linear");
    const { data, error } = await admin.rpc("attribution_campaign_report", { p_brand_id: brandId, p_from: from, p_to: to, p_model: m, p_version: v });
    if (error) throw new Error(error.message);
    // The model and version are always returned so a report can never silently change meaning.
    return { model: m, version: v, from, to, currency: tenant.brand!.currency, rows: data ?? [] };
  }

  if (sub === "meta" && method === "GET") {
    const from = dateParam(req, "from", 30);
    const to = dateParam(req, "to", 0);
    const { data, error } = await admin.rpc("attribution_meta_comparison", { p_brand_id: brandId, p_from: from, p_to: to });
    if (error) throw new Error(error.message);
    return { from, to, rows: data ?? [] };
  }

  throw new RouteError(404, "Not found");
}
