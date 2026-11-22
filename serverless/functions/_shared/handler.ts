import { handleCors } from "./cors.ts";
import { errorResponse } from "./response.ts";
import { HttpError } from "./http.ts";
import { UpstreamError } from "./upstream.ts";
import { logger } from "./logger.ts";

export type Handler = (req: Request) => Promise<Response>;

/**
 * Wraps a function body with CORS preflight, method check and consistent error mapping:
 *   HttpError -> its status, UpstreamError -> 502/504, anything else -> 500 (generic message).
 */
export function wrapHandler(name: string, body: Handler, methods: string[] = ["POST"]): Handler {
  return async (req: Request) => {
    const cors = handleCors(req);
    if (cors) return cors;
    if (!methods.includes(req.method)) return errorResponse("Method not allowed", 405);

    const started = Date.now();
    try {
      return await body(req);
    } catch (err) {
      const ms = Date.now() - started;
      if (err instanceof HttpError) {
        if (err.status >= 500) logger.error(`${name} failed`, { status: err.status, error: err.message, duration_ms: ms });
        return errorResponse(err.message, err.status, err.details);
      }
      if (err instanceof UpstreamError) {
        logger.error(`${name} upstream failure`, { kind: err.kind, status: err.status, duration_ms: ms });
        return errorResponse(err.message, err.kind === "timeout" ? 504 : 502, { upstream_status: err.status, kind: err.kind });
      }
      const msg = String((err as Error)?.message ?? "");
      logger.error(`${name} crashed`, { error: msg, duration_ms: ms });
      // Never echo arbitrary exception text (SQL errors, library internals) to the client.
      // Operator-facing configuration errors are safe and actionable, so they are passed through.
      const safe = msg.startsWith("Server misconfiguration") ? msg : "internal error";
      return errorResponse(`${name} failed: ${safe}`, 500);
    }
  };
}
