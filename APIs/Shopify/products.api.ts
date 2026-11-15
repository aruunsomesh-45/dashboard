import { apiClient } from "../client";

export interface ShopifyVariant {
  id: string;
  title: string;
  sku: string;
  price_minor: number;
  inventory_quantity: number;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  status: "active" | "archived" | "draft";
  variants_count: number;
  variants: ShopifyVariant[];
  created_at: string;
  updated_at: string;
}

/**
 * Shopify Products & Inventory API Client
 * Used to fetch product catalog, SKUs, inventory counts, and price lists.
 */
export const shopifyProductsApi = {
  /**
   * Retrieves products and SKU catalog for the brand.
   */
  async getProducts(workspaceSlug: string, brandId: string): Promise<ShopifyProduct[]> {
    return apiClient<ShopifyProduct[]>(`/api/w/${workspaceSlug}/b/${brandId}/commerce/products/`, {
      method: "GET",
    });
  },

  /**
   * Retrieves low inventory alerts across all active SKUs.
   */
  async getLowStockAlerts(workspaceSlug: string, brandId: string, threshold = 10): Promise<ShopifyVariant[]> {
    return apiClient<ShopifyVariant[]>(`/api/w/${workspaceSlug}/b/${brandId}/commerce/inventory/low-stock/`, {
      method: "GET",
      params: { threshold },
    });
  },
};
