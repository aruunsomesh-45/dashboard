// Authentication is a server-side Django session carried by an HTTP-only `sessionid` cookie.
// Nothing auth-related is ever stored in JS-readable storage; requests just include cookies.

/** Error thrown by apiFetch. `status` is the HTTP status; `fields` holds per-field validation messages. */
export class ApiError extends Error {
  status: number;
  fields: Record<string, string[]>;
  constructor(message: string, status: number, fields: Record<string, string[]> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
  }
}

/** Fired on window whenever an internal API call answers 401 (session missing or expired). */
export const SESSION_EXPIRED_EVENT = "auth:session-expired";

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
  return (await apiFetchWithStatus<T>(endpoint, options)).data;
}

/** Same as apiFetch, but also returns the HTTP status code (used to show real status in UI messages). */
export async function apiFetchWithStatus<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ status: number; data: T }> {
  const isExternal = endpoint.startsWith("http://") || endpoint.startsWith("https://");
  const url = isExternal ? endpoint : (endpoint.startsWith("/") ? endpoint : `/${endpoint}`);
  const method = (options.method ?? "GET").toUpperCase();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  // Only attach internal authentication and CSRF headers to internal endpoints
  if (!isExternal) {
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
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      method,
      headers,
      credentials: isExternal ? "omit" : "include", // Do not send internal cookies to external APIs
    });
  } catch (err: any) {
    if (isExternal) {
      throw new Error(`Failed to connect to external API (${url}): ${err?.message || "Network Error"}`);
    }
    throw new Error(
      "Cannot connect to the backend server. Please make sure the Django server is running on port 8001."
    );
  }

  // Log status code and sample of response for QA verification
  const contentType = response.headers.get("content-type") || "";
  let responseData: any = null;

  if (contentType.includes("application/json")) {
    try {
      responseData = await response.json();
    } catch {
      responseData = null;
    }
  } else {
    try {
      responseData = await response.text();
    } catch {
      responseData = null;
    }
  }

  if (typeof window !== "undefined" && !url.startsWith("/api/auth/")) {
    // Keep the logged sample small: first 2 items of arrays, max 300 chars overall.
    let sample: string | undefined;
    try {
      sample = JSON.stringify(Array.isArray(responseData) ? responseData.slice(0, 2) : responseData)?.slice(0, 300);
    } catch {
      sample = undefined;
    }
    console.log(`[API ${method}] ${url} -> Status: ${response.status}`, {
      status: response.status,
      ok: response.ok,
      sample,
    });
  }

  if (!response.ok) {
    let errorDetail = "";
    if (response.status >= 500 && !isExternal) {
      errorDetail = "Backend server is temporarily unavailable. Please verify the service is running.";
    } else if (responseData && typeof responseData === "object") {
      const rawError =
        responseData.error ||
        responseData.detail ||
        responseData.message ||
        (Array.isArray(responseData) ? responseData[0] : null) ||
        Object.values(responseData)[0] ||
        response.statusText;

      if (typeof rawError === "object" && rawError !== null) {
        errorDetail =
          rawError.message || rawError.detail || rawError.error || JSON.stringify(rawError);
      } else {
        errorDetail = String(rawError || "");
      }
      if (Array.isArray(errorDetail)) {
        errorDetail = errorDetail[0];
      }
      if (/an error occurred with this application/i.test(errorDetail)) {
        errorDetail = "Backend server is temporarily unavailable. Please verify the service is running.";
      }
    } else if (typeof responseData === "string" && responseData.length < 200) {
      errorDetail = /an error occurred with this application/i.test(responseData)
        ? "Backend server is temporarily unavailable. Please verify the service is running."
        : responseData;
    } else {
      errorDetail = response.statusText;
    }
    const fields =
      responseData && typeof responseData === "object" && responseData.fields && typeof responseData.fields === "object"
        ? (responseData.fields as Record<string, string[]>)
        : {};
    if (response.status === 401 && !isExternal && typeof window !== "undefined" && !url.startsWith("/api/auth/")) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(String(errorDetail || `Request failed with status ${response.status}`), response.status, fields);
  }

  if (response.status === 204 || responseData === null) {
    return { status: response.status, data: {} as T };
  }

  return { status: response.status, data: responseData as T };
}
