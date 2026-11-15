import { apiClient } from "../client";

export interface TenantWorkspace {
  id: string;
  name: string;
  slug: string;
  brands: Array<{
    id: string;
    name: string;
    currency: string;
    timezone: string;
  }>;
}

/**
 * Supabase Postgres Database & Tenancy API Client
 * Used to query workspace entities, brand scopes, audit logs, and RLS tenant boundaries.
 */
export const supabaseDatabaseApi = {
  /**
   * Retrieves all workspaces and brands accessible to the authenticated user.
   */
  async getWorkspaces(): Promise<TenantWorkspace[]> {
    return apiClient<TenantWorkspace[]>("/api/w/", {
      method: "GET",
    });
  },

  /**
   * Retrieves single workspace by slug.
   */
  async getWorkspaceBySlug(slug: string): Promise<TenantWorkspace> {
    return apiClient<TenantWorkspace>(`/api/w/${slug}/`, {
      method: "GET",
    });
  },
};
