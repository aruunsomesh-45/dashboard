// Supabase Edge Function entrypoint. The request logic lives in ./handler.ts so it can be
// unit-tested with injected dependencies and reused by serverless/local-gateway.ts.
import { createHandler } from "./handler.ts";
import { defaultDeps } from "../_shared/deps.ts";

Deno.serve(createHandler(defaultDeps()));
