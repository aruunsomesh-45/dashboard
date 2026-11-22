export interface ConnectionTestResult {
  integration_name: string;
  connection_status: "connected" | "failed";
  http_status: number;
  response_time: number;
  last_tested_at: string;
  records_fetched: number;
  error_message: string | null;
  account_info?: {
    identifier?: string;
    name?: string;
  };
}

/**
 * Calls a Supabase Edge Function through the same-origin proxy (/api/fn/<name>), which forwards the
 * session JWT from the HTTP-only cookie. The browser holds no Supabase session of its own.
 */
export async function invokeEdgeFunction<T>(
  functionName: string,
  payload: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`/api/fn/${encodeURIComponent(functionName)}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Edge Function ${functionName} responded with status ${res.status}`);
  }

  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Edge Function returned status ${res.status}`);
  }

  return (json.data ?? json) as T;
}
