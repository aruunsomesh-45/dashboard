import { apiClient } from "../client";

export interface ShipmentItem {
  id: string;
  order_number: string;
  awb_code: string;
  carrier: "delhivery" | "shiprocket" | "bluedart";
  status: "manifested" | "in_transit" | "out_for_delivery" | "delivered" | "ndr" | "rto";
  shipping_cost_minor: number;
  customer_city: string;
  customer_pincode: string;
  dispatched_at: string;
  estimated_delivery_at?: string;
  delivered_at?: string;
}

export interface LogisticsSummary {
  in_transit_count: number;
  delivered_count: number;
  ndr_count: number;
  rto_rate_percentage: number;
  avg_delivery_days: number;
  total_shipping_spend_minor: number;
}

/**
 * Logistics Shipments API Client
 * Used to monitor order fulfillment, dispatch pipelines, and carrier cost reconciliation.
 */
export const logisticsShipmentsApi = {
  /**
   * Retrieves shipment list and fulfillment state.
   */
  async getShipments(workspaceSlug: string, brandId: string, limit = 50): Promise<ShipmentItem[]> {
    return apiClient<ShipmentItem[]>(`/api/w/${workspaceSlug}/b/${brandId}/logistics/shipments/`, {
      method: "GET",
      params: { limit },
    });
  },

  /**
   * Retrieves logistics summary KPIs (NDR, RTO rate, transit SLA).
   */
  async getSummary(workspaceSlug: string, brandId: string, days = 30): Promise<LogisticsSummary> {
    return apiClient<LogisticsSummary>(`/api/w/${workspaceSlug}/b/${brandId}/logistics/summary/`, {
      method: "GET",
      params: { days },
    });
  },
};
