import { apiClient } from "../client";

export interface PnLStatement {
  period: string;
  gross_revenue_minor: number;
  discounts_minor: number;
  returns_minor: number;
  net_revenue_minor: number;
  cogs_minor: number; // Cost of Goods Sold
  gross_profit_minor: number;
  marketing_spend_minor: number; // Meta Ads + Influencers
  shipping_costs_minor: number; // Delhivery + RTO costs
  gateway_fees_minor: number; // Razorpay fees
  operating_expenses_minor: number; // Packaging, team, overhead
  ebitda_minor: number;
  net_margin_percentage: number;
}

/**
 * Profit & Loss (P&L) Intelligence API Client
 * Used to calculate true net margin, unit economics, contribution margins, and bottom-line profit.
 */
export const dashboardPnlApi = {
  /**
   * Retrieves deterministic brand P&L statement computed from verified source ledgers.
   */
  async getPnlStatement(workspaceSlug: string, brandId: string, days = 30): Promise<PnLStatement> {
    return apiClient<PnLStatement>(`/api/w/${workspaceSlug}/b/${brandId}/analytics/pnl/`, {
      method: "GET",
      params: { days },
    });
  },
};
