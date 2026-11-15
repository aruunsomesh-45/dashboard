import { apiClient } from "../client";

export interface RazorpayPayment {
  id: string; // rzp_pay_...
  order_id: string; // rzp_order_...
  amount_minor: number; // in paise
  currency: string;
  status: "captured" | "authorized" | "failed" | "refunded";
  method: "card" | "netbanking" | "wallet" | "upi";
  fee_minor: number;
  tax_minor: number;
  email: string;
  contact: string;
  created_at: string;
}

export interface PaymentStats {
  authorized_rate: number;
  total_captured_minor: number;
  total_fees_minor: number;
  payment_count: number;
}

/**
 * Razorpay Payments API Client
 * Used to reconcile real-time payments, authorization rates, gateway fees, and UPI/Card splits.
 */
export const razorpayPaymentsApi = {
  /**
   * Retrieves payments list with fee and tax deductions.
   */
  async getPayments(workspaceSlug: string, brandId: string, limit = 50): Promise<RazorpayPayment[]> {
    return apiClient<RazorpayPayment[]>(`/api/w/${workspaceSlug}/b/${brandId}/payments/transactions/`, {
      method: "GET",
      params: { limit },
    });
  },

  /**
   * Retrieves payment conversion funnel & authorization success rates.
   */
  async getPaymentStats(workspaceSlug: string, brandId: string, days = 30): Promise<PaymentStats> {
    return apiClient<PaymentStats>(`/api/w/${workspaceSlug}/b/${brandId}/payments/stats/`, {
      method: "GET",
      params: { days },
    });
  },
};
