/**
 * 125 EAST Commerce Intelligence API Client
 * Shared HTTP fetch transport with Supabase JWT & CSRF propagation.
 */

export interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

const getBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    return ""; // Relative to browser host (proxied via Next.js)
  }
  return process.env.BACKEND_URL || "http://127.0.0.1:8001";
};

export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { params, headers = {}, ...rest } = options;

  let url = `${getBaseUrl()}${endpoint}`;
  if (params) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, val]) => {
      if (val !== undefined && val !== null) {
        query.append(key, String(val));
      }
    });
    const qs = query.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(headers as Record<string, string>),
  };

  const response = await fetch(url, {
    ...rest,
    headers: reqHeaders,
    credentials: "include",
  });

  if (!response.ok) {
    let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
    try {
      const errJson = await response.json();
      errorMsg = errJson.error || errJson.detail || errorMsg;
    } catch {
      // response not JSON
    }
    throw new Error(errorMsg);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
