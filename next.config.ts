import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/materials",
        destination: "/posts",
        permanent: true,
      },
      {
        source: "/materials/:path*",
        destination: "/posts/:path*",
        permanent: true,
      },
      {
        source: "/sources",
        destination: "/feeds",
        permanent: true,
      },
      {
        source: "/sources/:path*",
        destination: "/feeds/:path*",
        permanent: true,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  // Sentry 11's replacement for `disableLogger`: tree-shakes the SDK's debug
  // logging. Applied by both webpack and Turbopack (Next >= 15.4).
  bundleSizeOptimizations: { excludeDebugStatements: true },
  // The plugin sends build telemetry to Sentry by default. SELF_HOSTING.md
  // promises "no telemetry to us", so this build sends no Sentry build
  // telemetry.
  telemetry: false,
});
