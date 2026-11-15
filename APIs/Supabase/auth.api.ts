import { apiClient } from "../client";

export interface UserProfile {
  id: string;
  email: string;
  fullName?: string;
  avatarUrl?: string;
  workspaces: Array<{
    id: string;
    slug: string;
    name: string;
    role: "owner" | "admin" | "member" | "viewer";
  }>;
}

/**
 * Supabase Auth API Client
 * Used for user session verification, JWT validation, multi-tenant workspace switching, and MFA state.
 */
export const supabaseAuthApi = {
  /**
   * Retrieves current authenticated user profile & tenant memberships.
   */
  async getCurrentUser(): Promise<UserProfile> {
    return apiClient<UserProfile>("/api/auth/me/", {
      method: "GET",
    });
  },

  /**
   * Refreshes CSRF protection token.
   */
  async refreshCsrfToken(): Promise<{ csrfToken: string }> {
    return apiClient<{ csrfToken: string }>("/api/auth/csrf/", {
      method: "GET",
    });
  },

  /**
   * Logs out user and destroys backend session.
   */
  async logout(): Promise<{ success: boolean }> {
    return apiClient<{ success: boolean }>("/api/auth/logout/", {
      method: "POST",
    });
  },
};
