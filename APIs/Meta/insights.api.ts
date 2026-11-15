import { apiClient } from "../client";

export interface MetaInsightsSummary {
  spend_minor: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc_minor: number;
  cpm_minor: number;
  orders: number;
  attributed_revenue_minor: number;
  roas: number;
}

export interface MetaDailyTrend {
  date: string;
  spend_minor: number;
  impressions: number;
  clicks: number;
  orders: number;
  attributed_revenue_minor: number;
  roas: number;
}

export interface MetaMarketingStats {
  connected: boolean;
  account?: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
  };
  summary_30d?: MetaInsightsSummary;
  summary_lifetime?: MetaInsightsSummary;
  daily_trends?: MetaDailyTrend[];
  last_synced_at?: string;
  token_expired?: boolean;
}

/**
 * Meta Marketing Insights API Client
 * Used to pull aggregate spend, click attribution, CPM/CPC trends, and 28-day conversion restatements.
 */
export const metaInsightsApi = {
  /**
   * Retrieves aggregated 30-day and lifetime ad intelligence and daily trends.
   */
  async getInsights(workspaceSlug: string, brandId: string): Promise<MetaMarketingStats> {
    return apiClient<MetaMarketingStats>(`/api/w/${workspaceSlug}/b/${brandId}/marketing/stats/`, {
      method: "GET",
    });
  },

  /**
   * Triggers on-demand real-time pull from Meta Graph API v21.0.
   */
  async triggerSync(workspaceSlug: string, brandId: string): Promise<MetaMarketingStats> {
    return apiClient<MetaMarketingStats>(`/api/w/${workspaceSlug}/b/${brandId}/marketing/sync-now/`, {
      method: "POST",
    });
  },
};
