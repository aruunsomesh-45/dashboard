import { apiClient } from "../client";

export interface DashboardOverviewKPIs {
  net_revenue_minor: number;
  total_orders: number;
  ad_spend_minor: number;
  blended_roas: number;
  cash_in_bank_minor: number;
  ndr_rate_percent: number;
  profit_margin_percent: number;
}

/**
 * Executive Dashboard Overview API Client
 * Used to power the high-level business command center (cross-channel KPI aggregates).
 */
export const dashboardOverviewApi = {
  /**
   * Retrieves blended executive KPI scorecards for the active brand.
   */
  async getOverview(workspaceSlug: string, brandId: string, days = 30): Promise<DashboardOverviewKPIs> {
    return apiClient<DashboardOverviewKPIs>(`/api/w/${workspaceSlug}/b/${brandId}/metrics/`, {
      method: "GET",
      params: { days },
    });
  },
};
