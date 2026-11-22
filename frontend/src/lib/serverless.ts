import { supabase } from "./supabaseClient";

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

export async function invokeEdgeFunction<T>(
  functionName: string,
  payload: Record<string, unknown>
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || "";

  const functionsBaseUrl =
    process.env.NEXT_PUBLIC_FUNCTIONS_URL ||
    (typeof window !== "undefined"
      ? `http://${window.location.hostname}:54321/functions/v1`
      : "http://127.0.0.1:54321/functions/v1");

  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlieXJveHlvZnFmcG96dmZlZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMjg2NjksImV4cCI6MjEwOTkwNDY2OX0.tGUf2QP8SpmS0ml19cCRPJ4wdV5hW8NeWwgPCe7rA4s";

  const res = await fetch(`${functionsBaseUrl}/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? `Bearer ${token}` : "",
      apikey: anonKey,
    },
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
