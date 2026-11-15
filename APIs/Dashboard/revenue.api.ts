import { apiClient } from "../client";

export interface DailyRevenueDataPoint {
  date: string;
  gross_sales_minor: number;
  discounts_minor: number;
  returns_minor: number;
  taxes_minor: number;
  net_sales_minor: number;
  orders_count: number;
}

/**
 * Dashboard Revenue Analytics API Client
 * Used to render revenue charts, daily growth trajectories, and discount velocity.
 */
export const dashboardRevenueApi = {
  /**
   * Retrieves daily revenue breakdown over the specified time range.
   */
  async getDailyRevenue(workspaceSlug: string, brandId: string, days = 30): Promise<DailyRevenueDataPoint[]> {
    return apiClient<DailyRevenueDataPoint[]>(`/api/w/${workspaceSlug}/b/${brandId}/analytics/revenue-trends/`, {
      method: "GET",
      params: { days },
    });
  },
};
