import { apiClient } from "../client";

export interface TrackingScan {
  timestamp: string;
  location: string;
  activity: string;
  status: string;
}

export interface TrackingDetails {
  awb_code: string;
  carrier: string;
  current_status: string;
  origin: string;
  destination: string;
  scans: TrackingScan[];
}

/**
 * Logistics AWB Tracking API Client
 * Used for live AWB scans, real-time NDR (Non-Delivery Report) resolution, and RTO return tracking.
 */
export const logisticsTrackingApi = {
  /**
   * Tracks AWB package across Delhivery / carrier network.
   */
  async trackAwb(workspaceSlug: string, brandId: string, awbCode: string): Promise<TrackingDetails> {
    return apiClient<TrackingDetails>(`/api/w/${workspaceSlug}/b/${brandId}/logistics/track/${awbCode}/`, {
      method: "GET",
    });
  },

  /**
   * Action trigger for NDR re-attempt (customer requested re-delivery).
   */
  async triggerNdrReattempt(
    workspaceSlug: string,
    brandId: string,
    awbCode: string,
    action: "reattempt" | "return_to_origin"
  ): Promise<{ success: boolean; message: string }> {
    return apiClient<{ success: boolean; message: string }>(
      `/api/w/${workspaceSlug}/b/${brandId}/logistics/ndr/${awbCode}/action/`,
      {
        method: "POST",
        body: JSON.stringify({ action }),
      }
    );
  },
};
