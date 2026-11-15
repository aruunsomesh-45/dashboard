import { apiClient } from "../client";
import { SupportedProvider } from "./sync.api";

export interface IntegrationStatus {
  id: string;
  provider: SupportedProvider;
  status: "connected" | "disconnected" | "syncing" | "error" | "token_expiring";
  account_identifier: string;
  last_synced_at: string | null;
  last_error_message?: string;
  token_expires_at?: string | null;
}

export interface SyncRunLog {
  id: string;
  provider: string;
  status: "running" | "success" | "failed";
  records_processed: number;
  records_created: number;
  records_updated: number;
  error_message?: string;
  started_at: string;
  finished_at?: string;
}

/**
 * Sync Health & Status API Client
 * Used to inspect integration health, live connection statuses, token expirations, and audit logs.
 */
export const syncStatusApi = {
  /**
   * Retrieves status for all installed apps and connectors for a brand.
   */
  async getIntegrationStatuses(workspaceSlug: string, brandId: string): Promise<IntegrationStatus[]> {
    return apiClient<IntegrationStatus[]>(`/api/w/${workspaceSlug}/b/${brandId}/integrations/`, {
      method: "GET",
    });
  },

  /**
   * Saves or updates encrypted credentials for a provider.
   */
  async saveCredentials(
    workspaceSlug: string,
    brandId: string,
    provider: SupportedProvider,
    credentials: Record<string, string>,
    accountIdentifier?: string
  ): Promise<IntegrationStatus> {
    return apiClient<IntegrationStatus>(`/api/w/${workspaceSlug}/b/${brandId}/integrations/`, {
      method: "POST",
      body: JSON.stringify({
        provider,
        credentials,
        account_identifier: accountIdentifier,
      }),
    });
  },

  /**
   * Disconnects an integration and pauses scheduled webhooks.
   */
  async disconnectIntegration(
    workspaceSlug: string,
    brandId: string,
    provider: SupportedProvider
  ): Promise<{ status: string; provider: string }> {
    return apiClient<{ status: string; provider: string }>(
      `/api/w/${workspaceSlug}/b/${brandId}/integrations/?provider=${encodeURIComponent(provider)}`,
      { method: "DELETE" }
    );
  },

  /**
   * Retrieves recent audit logs and execution history of sync runs.
   */
  async getSyncRuns(workspaceSlug: string, brandId: string): Promise<SyncRunLog[]> {
    return apiClient<SyncRunLog[]>(`/api/w/${workspaceSlug}/b/${brandId}/integrations/sync-runs/`, {
      method: "GET",
    });
  },
};
