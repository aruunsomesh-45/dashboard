import { corsHeaders } from "./cors.ts";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string | null;
  details?: unknown;
  timestamp: string;
}

export function jsonResponse<T>(
  payload: ApiResponse<T>,
  status = 200
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

export function successResponse<T>(data: T, status = 200): Response {
  return jsonResponse<T>(
    {
      success: true,
      data,
      error: null,
      timestamp: new Date().toISOString(),
    },
    status
  );
}

export function errorResponse(
  message: string,
  status = 400,
  details: unknown = null
): Response {
  return jsonResponse<null>(
    {
      success: false,
      error: message,
      details,
      timestamp: new Date().toISOString(),
    },
    status
  );
}
