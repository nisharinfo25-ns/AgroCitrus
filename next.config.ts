import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the tracing root to this project so Next.js doesn't walk up to the
  // user home directory and pick up a conflicting lockfile there.
  outputFileTracingRoot: path.resolve(__dirname),
  // `sharp` is optional; Next falls back to its WASM build if unavailable.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "bpmoafdikilbpcxbbmyi.supabase.co" },
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
  // The Python ML runtime + model cache live outside the Next build output and
  // must never be traced/bundled. They are provisioned at runtime instead.
  outputFileTracingExcludes: {
    "*": [".cache/citrusguard/**/*", "models/**/*", "data/**/*", "ml/**/__pycache__/**/*"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
