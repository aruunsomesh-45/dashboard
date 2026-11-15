import { apiClient } from "../client";

export interface ShopifyCustomer {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  orders_count: number;
  total_spent_minor: number; // In paise
  created_at: string;
}

/**
 * Shopify Customers API Client
 * Used for Customer Lifetime Value (LTV), repurchase cohort analysis, and customer profiles.
 */
export const shopifyCustomersApi = {
  /**
   * Retrieves paginated customer profiles sorted by LTV (total spent).
   */
  async getCustomers(workspaceSlug: string, brandId: string, limit = 50): Promise<ShopifyCustomer[]> {
    return apiClient<ShopifyCustomer[]>(`/api/w/${workspaceSlug}/b/${brandId}/commerce/customers/`, {
      method: "GET",
      params: { limit },
    });
  },

  /**
   * Retrieves single customer details and order history.
   */
  async getCustomerById(workspaceSlug: string, brandId: string, customerId: string): Promise<ShopifyCustomer> {
    return apiClient<ShopifyCustomer>(`/api/w/${workspaceSlug}/b/${brandId}/commerce/customers/${customerId}/`, {
      method: "GET",
    });
  },
};
