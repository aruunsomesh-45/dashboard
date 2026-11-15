import { apiClient } from "../client";

export interface MetaAdCreative {
  id: string;
  name: string;
  adset_id: string;
  adset_name: string;
  campaign_id: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  spend_minor: number;
  clicks: number;
  ctr: number;
  roas: number;
  thumbnail_url?: string;
}

/**
 * Meta Ad Creatives & Adsets API Client
 * Used to inspect individual creative asset performance (Reels, Carousels, Static image ads) and identify fatigue.
 */
export const metaAdsApi = {
  /**
   * Retrieves ad creatives ranked by ROAS and spend.
   */
  async getAdCreatives(workspaceSlug: string, brandId: string, campaignId?: string): Promise<MetaAdCreative[]> {
    return apiClient<MetaAdCreative[]>(`/api/w/${workspaceSlug}/b/${brandId}/marketing/ads/`, {
      method: "GET",
      params: { campaign_id: campaignId },
    });
  },
};
