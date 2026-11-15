import { apiClient } from "../client";

export interface WebhookConfig {
  url: string;
  secret_configured: boolean;
  events: string[];
}

/**
 * Razorpay Webhooks API Client
 * Used to verify signature (X-Razorpay-Signature) and register payment webhooks.
 */
export const razorpayWebhooksApi = {
  /**
   * Retrieves active webhook registration status.
   */
  async getWebhookConfig(workspaceSlug: string, brandId: string): Promise<WebhookConfig> {
    return apiClient<WebhookConfig>(`/api/w/${workspaceSlug}/b/${brandId}/payments/webhooks/config/`, {
      method: "GET",
    });
  },
};
