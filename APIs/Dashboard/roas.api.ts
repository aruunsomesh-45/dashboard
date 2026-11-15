import { apiClient } from "../client";

export interface ChannelRoasBreakdown {
  channel: "meta_ads" | "google_ads" | "influencers" | "organic";
  spend_minor: number;
  attributed_revenue_minor: number;
  roas: number;
  blended_cac_minor: number;
}

/**
 * Marketing Efficiency & Blended ROAS API Client
 * Used to compute cross-platform blended MER (Marketing Efficiency Ratio), ad spend vs realized cash flow.
 */
export const dashboardRoasApi = {
  /**
   * Retrieves blended and per-channel ROAS efficiency metrics.
   */
  async getRoasMetrics(workspaceSlug: string, brandId: string, days = 30): Promise<ChannelRoasBreakdown[]> {
    return apiClient<ChannelRoasBreakdown[]>(`/api/w/${workspaceSlug}/b/${brandId}/analytics/roas/`, {
      method: "GET",
      params: { days },
    });
  },
};
