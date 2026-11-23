// Next.js instrumentation hook: initialises Sentry in the server and edge runtimes.
// Sentry stays a no-op unless SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN is set (see the config files).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}
