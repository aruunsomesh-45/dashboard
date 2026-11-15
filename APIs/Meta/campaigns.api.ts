import { apiClient } from "../client";

export interface MetaCampaign {
  id: string;
  name: string;
  status: "active" | "paused";
  effective_status?: string;
  spend_minor: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc_minor: number;
  roas: number;
  orders: number;
  attributed_revenue_minor: number;
}

/**
 * Meta Campaigns API Client
 * Used to fetch active/paused campaigns, delivery status, budget allocation, and campaign-level ROAS.
 */
export const metaCampaignsApi = {
  /**
   * Fetches all campaigns with consolidated performance metrics.
   */
  async getCampaigns(workspaceSlug: string, brandId: string): Promise<MetaCampaign[]> {
    const res = await apiClient<{ campaigns: MetaCampaign[] }>(
      `/api/w/${workspaceSlug}/b/${brandId}/marketing/stats/`,
      { method: "GET" }
    );
    return res.campaigns || [];
  },

  /**
   * Toggles campaign status (ACTIVE / PAUSED).
   */
  async updateCampaignStatus(
    workspaceSlug: string,
    brandId: string,
    campaignId: string,
    status: "ACTIVE" | "PAUSED"
  ): Promise<{ success: boolean; status: string }> {
    return apiClient<{ success: boolean; status: string }>(
      `/api/w/${workspaceSlug}/b/${brandId}/marketing/campaigns/${campaignId}/status/`,
      {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }
    );
  },
};
