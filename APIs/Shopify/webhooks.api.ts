import { apiClient } from "../client";

export interface ShopifyWebhookSubscription {
  id: string;
  topic: "orders/create" | "orders/updated" | "orders/fulfilled" | "refunds/create" | "products/update";
  address: string;
  format: "json";
}

/**
 * Shopify Webhooks API Client
 * Used to manage inbound real-time event webhooks verified with HMAC SHA-256.
 */
export const shopifyWebhooksApi = {
  /**
   * Registers required Shopify webhooks for real-time order & refund event streaming.
   */
  async registerWebhooks(workspaceSlug: string, brandId: string): Promise<{ registered: string[]; status: string }> {
    return apiClient<{ registered: string[]; status: string }>(
      `/api/w/${workspaceSlug}/b/${brandId}/shopify/webhooks/register/`,
      { method: "POST" }
    );
  },

  /**
   * Returns list of currently active webhook topics for the brand.
   */
  async getActiveWebhooks(workspaceSlug: string, brandId: string): Promise<ShopifyWebhookSubscription[]> {
    return apiClient<ShopifyWebhookSubscription[]>(`/api/w/${workspaceSlug}/b/${brandId}/shopify/webhooks/`, {
      method: "GET",
    });
  },
};
