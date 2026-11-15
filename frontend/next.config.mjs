import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_OUTPUT_STANDALONE === "true" ? "standalone" : undefined,
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8001";
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

// Source-map upload only happens when SENTRY_AUTH_TOKEN is set (CI); otherwise this is a transparent wrapper.
export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  telemetry: false,
  disableLogger: true,
});
