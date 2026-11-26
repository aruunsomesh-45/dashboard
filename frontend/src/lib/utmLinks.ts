/**
 * Campaign link builder (pure; used by the API route and the Campaign Links page).
 *
 * Naming convention (so channel classification stays consistent):
 *   lower-case, words joined by "_", only [a-z0-9_.-], max 100 chars.
 * Every generated link also carries utm_id=<link_code>, which identifies the exact link in visits
 * (storefront pixel) and in orders (Razorpay Magic Checkout keeps utm_id in rzp_3p_utm).
 */
export const PLACEMENTS = {
  instagram_bio: { label: "Instagram bio link", source: "instagram", medium: "organic_social", content: "bio_link" },
  instagram_story: { label: "Instagram story link", source: "instagram", medium: "organic_social", content: "story_link" },
  instagram_post: { label: "Instagram organic post", source: "instagram", medium: "organic_social", content: "post" },
  instagram_reel: { label: "Instagram reel", source: "instagram", medium: "organic_social", content: "reel" },
  meta_ads: { label: "Meta Ads (static link)", source: "meta", medium: "paid_social", content: "" },
  google_ads: { label: "Google Ads", source: "google", medium: "cpc", content: "" },
  email: { label: "Email campaign", source: "email", medium: "email", content: "" },
  influencer: { label: "Influencer", source: "instagram", medium: "influencer", content: "" },
  whatsapp: { label: "WhatsApp campaign", source: "whatsapp", medium: "messaging", content: "" },
  sms: { label: "SMS campaign", source: "sms", medium: "sms", content: "" },
  custom: { label: "Other / custom", source: "", medium: "", content: "" },
} as const;

export type Placement = keyof typeof PLACEMENTS;

export interface LinkInput {
  placement: Placement;
  destination_url: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign: string;
  utm_content?: string;
  utm_term?: string;
  influencer_handle?: string;
  label?: string;
}

export interface BuiltLink {
  placement: Placement;
  destination_url: string;
  final_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string | null;
  utm_term: string | null;
  influencer_handle: string | null;
  label: string;
}

export class LinkValidationError extends Error {}

/** "Diwali Sale 2026!" -> "diwali_sale_2026". Empty after cleaning -> "". */
export function slugUtm(v: unknown): string {
  return String(v ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/[\s/]+/g, "_")
    .replace(/[^a-z0-9_.-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 100);
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"];

export function validateDestination(raw: string, allowedHosts: string[] = []): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new LinkValidationError("Destination must be a full URL, e.g. https://125east.in/products/chrome-buds");
  }
  if (u.protocol !== "https:") throw new LinkValidationError("Destination must use https://");
  if (u.username || u.password) throw new LinkValidationError("Destination must not contain credentials");
  const host = u.hostname.toLowerCase();
  if (allowedHosts.length && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new LinkValidationError(`Destination must be on your store (${allowedHosts.join(", ")})`);
  }
  for (const k of UTM_KEYS) {
    if (u.searchParams.has(k)) throw new LinkValidationError(`Destination already contains ${k}; remove it so the link has one unambiguous attribution`);
  }
  return u;
}

export function buildLink(input: LinkInput, linkCode: string, allowedHosts: string[] = []): BuiltLink {
  if (!(input.placement in PLACEMENTS)) throw new LinkValidationError("Unknown placement");
  if (!/^l_[a-z0-9]{8,12}$/.test(linkCode)) throw new LinkValidationError("Invalid link code");
  const preset = PLACEMENTS[input.placement];
  const dest = validateDestination(input.destination_url, allowedHosts);

  const source = slugUtm(input.utm_source || preset.source);
  const medium = slugUtm(input.utm_medium || preset.medium);
  const campaign = slugUtm(input.utm_campaign);
  const handle = input.influencer_handle ? slugUtm(String(input.influencer_handle).replace(/^@/, "")) : "";
  const content = slugUtm(input.utm_content || (input.placement === "influencer" ? handle : preset.content)) || null;
  const term = slugUtm(input.utm_term) || null;
  if (!source) throw new LinkValidationError("Campaign source is required");
  if (!medium) throw new LinkValidationError("Campaign medium is required");
  if (!campaign) throw new LinkValidationError("Campaign name is required");
  if (input.placement === "influencer" && !handle) throw new LinkValidationError("Influencer handle is required for influencer links");

  // Existing query parameters and the #fragment are preserved; URLSearchParams handles encoding.
  const out = new URL(dest.toString());
  out.searchParams.set("utm_source", source);
  out.searchParams.set("utm_medium", medium);
  out.searchParams.set("utm_campaign", campaign);
  if (content) out.searchParams.set("utm_content", content);
  if (term) out.searchParams.set("utm_term", term);
  out.searchParams.set("utm_id", linkCode);

  return {
    placement: input.placement,
    destination_url: dest.toString(),
    final_url: out.toString(),
    utm_source: source,
    utm_medium: medium,
    utm_campaign: campaign,
    utm_content: content,
    utm_term: term,
    influencer_handle: handle || null,
    label: String(input.label ?? "").trim().slice(0, 200),
  };
}

/** 8 random base-36 characters from a CSPRNG. */
export function newLinkCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "l_" + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}
