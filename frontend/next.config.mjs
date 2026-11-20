import { withSentryConfig } from "@sentry/nextjs";

const isExport = process.env.NEXT_EXPORT === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
        ],
      },
    ];
  },
  ...(isExport ? {} : {
    async rewrites() {
      const defaultPublicTunnel = "https://motion-islamic-starting-window.trycloudflare.com";
      const backendUrl = process.env.BACKEND_URL || (process.env.VERCEL === "1" ? defaultPublicTunnel : "http://127.0.0.1:8001");
      // When deployed on Vercel without an external backend URL, avoid rewriting to private localhost
      if (process.env.VERCEL === "1" && (!backendUrl || backendUrl.includes("127.0.0.1") || backendUrl.includes("localhost"))) {
        return [];
      }
      return [
        {
          source: "/api/:path*",
          destination: `${backendUrl}/api/:path*`,
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
});
