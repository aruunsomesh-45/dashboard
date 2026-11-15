import * as Sentry from "@sentry/nextjs";

// No-op unless NEXT_PUBLIC_SENTRY_DSN is set (so local dev/e2e never report anywhere).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || "development",
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || 0),
  sendDefaultPii: false,
  beforeSend(event) {
    // Never ship auth material or emails to the error tracker.
    if (event.request?.headers) {
      delete (event.request.headers as Record<string, string>)["Authorization"];
      delete (event.request.headers as Record<string, string>)["Cookie"];
    }
    if (event.user) event.user = { id: event.user.id };
    return event;
  },
});
