import { supabase } from "./supabaseClient";

// ─── CSRF helpers ──────────────────────────────────────────────────────────
// Django sets a readable `csrftoken` cookie (CSRF_COOKIE_HTTPONLY = False).
// Every mutating request must include it as the X-CSRFToken header.
// SessionAuthentication in DRF enforces this — without it you get 403.

function getCsrfToken(): string {
  if (typeof document === "undefined") return ""; // SSR guard
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** Call once on app boot (and after logout) to ensure the csrftoken cookie exists. */
export async function ensureCsrf(): Promise<void> {
  // Only fetch if the cookie is missing
  if (getCsrfToken()) return;
  try {
    await fetch("/api/auth/csrf", {
      method: "GET",
      credentials: "include",
    });
  } catch {
    // Non-fatal — the cookie may still arrive; we'll retry on the next mutating request
  }
}

// ─── Main fetch wrapper ─────────────────────────────────────────────────────
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const method = (options.method ?? "GET").toUpperCase();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  // Attach Supabase JWT Bearer token for DRF SupabaseJWTAuthentication
  if (!headers["Authorization"]) {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`;
      }
    } catch {
      // Fall back to Django session cookie if Supabase session lookup fails
    }
  }

  // Attach CSRF token for all state-changing verbs
  if (MUTATING.has(method)) {
    const token = getCsrfToken();
    if (token) {
      headers["X-CSRFToken"] = token;
    } else {
      // Cookie missing — fetch it now then retry (handles cold-start edge case)
      await ensureCsrf();
      const retried = getCsrfToken();
      if (retried) headers["X-CSRFToken"] = retried;
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      method,
      headers,
      credentials: "include", // Send HttpOnly session cookie + csrftoken cookie
    });
  } catch {
    throw new Error(
      "Cannot connect to the backend server. Please make sure the Django server is running on port 8000."
    );
  }

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail =
        errorJson.error ||
        errorJson.detail ||
        (Array.isArray(errorJson) ? errorJson[0] : null) ||
        Object.values(errorJson)[0] ||
        response.statusText;
      if (Array.isArray(errorDetail)) {
        errorDetail = errorDetail[0];
      }
    } catch {
      if (response.status === 500) {
        errorDetail =
          "Backend connection failed (500). Please ensure Django is running on http://127.0.0.1:8001";
      } else {
        errorDetail = response.statusText;
      }
    }
    throw new Error(String(errorDetail || `Request failed with status ${response.status}`));
  }

  // Handle empty 204 / no-JSON responses
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }
  return {} as T;
}
