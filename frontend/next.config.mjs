import { withSentryConfig } from "@sentry/nextjs";

const isExport = process.env.NEXT_EXPORT === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  output: isExport ? "export" : (process.env.NEXT_OUTPUT_STANDALONE === "true" ? "standalone" : undefined),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
      {
        // The in-app guide is shown inside the Guide page, which is on the same site. Only this page may be framed by its own site.
        source: "/guide.html",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
  ...(isExport ? {} : {
    async rewrites() {
      // In serverless architecture (and Vercel production), /api/* is handled by
      // Supabase & Edge Functions. Only rewrite if explicitly enabled for legacy dev.
      if (process.env.VERCEL === "1" || process.env.ENABLE_BACKEND_REWRITES !== "true") {
        return [];
      }
      return [
        {
          source: "/api/:path*",
          destination: "http://127.0.0.1:8001/api/:path*",
        },
      ];
    },
  }),
};

// Source-map upload only happens when SENTRY_AUTH_TOKEN is set (CI); otherwise this is a transparent wrapper.
export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  telemetry: false,
  disableLogger: true,
  // Upload source maps to Sentry (when SENTRY_AUTH_TOKEN is set) but never serve them to browsers.
  hideSourceMaps: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
});
