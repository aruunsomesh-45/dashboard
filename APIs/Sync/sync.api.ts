import { apiClient } from "../client";

export type SupportedProvider = "shopify" | "meta_ads" | "razorpay" | "shiprocket" | "instagram";

export interface SyncTriggerResponse {
  status: "success" | "error";
  message: string;
  records_processed?: number;
  records_created?: number;
  records_updated?: number;
  last_synced_at?: string;
}

/**
 * Universal Data Synchronization API Client
 * Used to trigger real-time, on-demand data backfills and external API ingestion pipelines.
 */
export const syncApi = {
  /**
   * Triggers an immediate ingestion sync for a specified integration provider.
   */
  async triggerSync(
    workspaceSlug: string,
    brandId: string,
    provider: SupportedProvider
  ): Promise<SyncTriggerResponse> {
    if (provider === "shopify") {
      return apiClient<SyncTriggerResponse>(`/api/w/${workspaceSlug}/b/${brandId}/shopify/sync-now/`, {
        method: "POST",
      });
    }

    if (provider === "meta_ads") {
      return apiClient<SyncTriggerResponse>(`/api/w/${workspaceSlug}/b/${brandId}/marketing/sync-now/`, {
        method: "POST",
      });
    }

    // Generic integration sync endpoint
    return apiClient<SyncTriggerResponse>(`/api/w/${workspaceSlug}/b/${brandId}/integrations/sync-now/`, {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
  },
};
