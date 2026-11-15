import { apiClient } from "../client";

export interface ShopifyOrderLine {
  id: string;
  variant_id: string;
  title: string;
  sku: string;
  quantity: number;
  price_minor: number;
  total_discount_minor: number;
}

export interface ShopifyOrder {
  id: string;
  order_number: string;
  currency: string;
  gross_amount_minor: number;
  discount_amount_minor: number;
  tax_amount_minor: number;
  shipping_amount_minor: number;
  net_sales_minor: number;
  financial_status: "pending" | "authorized" | "partially_paid" | "paid" | "partially_refunded" | "refunded" | "voided";
  fulfillment_status: "fulfilled" | "partial" | "unfulfilled" | "restocked" | null;
  customer?: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
  };
  lines?: ShopifyOrderLine[];
  source_created_at: string;
}

export interface OrdersQueryOptions {
  days?: number;
  limit?: number;
  cursor_created_at?: string;
  cursor_id?: string;
  status?: string;
}

export interface OrdersResponse {
  brand: { id: string; name: string; currency: string };
  metrics: {
    gross_sales_minor: number;
    discount_total_minor: number;
    tax_total_minor: number;
    shipping_total_minor: number;
    net_sales_minor: number;
    order_count: number;
    aov_minor: number;
  };
  funnel: {
    placed: number;
    paid: number;
    fulfilled: number;
    partial: number;
    unfulfilled: number;
  };
  orders: ShopifyOrder[];
  pagination: {
    limit: number;
    has_next: boolean;
    next_cursor: { cursor_created_at: string | null; cursor_id: string } | null;
  };
}

/**
 * Shopify Orders API Client
 * Used to fetch orders, cursor pagination, and funnel statistics.
 */
export const shopifyOrdersApi = {
  /**
   * Fetches paged Shopify orders & aggregated financial stats for a brand.
   */
  async getOrders(workspaceSlug: string, brandId: string, options: OrdersQueryOptions = {}): Promise<OrdersResponse> {
    return apiClient<OrdersResponse>(`/api/w/${workspaceSlug}/b/${brandId}/shopify/stats/`, {
      method: "GET",
      params: {
        days: options.days || 30,
        limit: options.limit || 25,
        cursor_created_at: options.cursor_created_at,
        cursor_id: options.cursor_id,
      },
    });
  },

  /**
   * Fetches single order by ID.
   */
  async getOrderById(workspaceSlug: string, brandId: string, orderId: string): Promise<ShopifyOrder> {
    return apiClient<ShopifyOrder>(`/api/w/${workspaceSlug}/b/${brandId}/commerce/orders/${orderId}/`, {
      method: "GET",
    });
  },
};
