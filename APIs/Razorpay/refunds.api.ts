import { apiClient } from "../client";

export interface RazorpayRefund {
  id: string; // rzp_rfnd_...
  payment_id: string;
  amount_minor: number;
  currency: string;
  status: "pending" | "processed" | "failed";
  speed: "normal" | "optimum";
  notes?: Record<string, string>;
  created_at: string;
}

/**
 * Razorpay Refunds & Disputes API Client
 * Used to audit customer refunds, chargebacks, and gateway settlement deductions.
 */
export const razorpayRefundsApi = {
  /**
   * Lists processed refunds for the brand.
   */
  async getRefunds(workspaceSlug: string, brandId: string): Promise<RazorpayRefund[]> {
    return apiClient<RazorpayRefund[]>(`/api/w/${workspaceSlug}/b/${brandId}/payments/refunds/`, {
      method: "GET",
    });
  },

  /**
   * Initiates instant/normal refund for a transaction.
   */
  async createRefund(
    workspaceSlug: string,
    brandId: string,
    paymentId: string,
    amountMinor?: number
  ): Promise<RazorpayRefund> {
    return apiClient<RazorpayRefund>(`/api/w/${workspaceSlug}/b/${brandId}/payments/refunds/`, {
      method: "POST",
      body: JSON.stringify({ payment_id: paymentId, amount_minor: amountMinor }),
    });
  },
};
