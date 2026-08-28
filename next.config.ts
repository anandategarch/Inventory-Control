import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  // Disable Next.js dev tools floating widget ("N" circle in bottom-right)
  devIndicators: false,
  // FIX: enable gzip compression for API responses (334KB → ~40KB, 85% reduction)
  compress: true,
  // PERF-OPT: drop the "X-Powered-By: Next.js" response header — saves a few
  // bytes per response AND avoids advertising the framework (minor security
  // hygiene bonus).
  poweredByHeader: false,
  // PERF-FASE2-INFRA01: Tree-shake large barrel-export libraries.
  // recharts exports 50+ chart components from its root — without this,
  // importing one chart (e.g. <LineChart>) pulls the entire library graph.
  // lucide-react exports 1000+ icons from root — same issue.
  // date-fns exports 200+ date functions from root.
  // `optimizePackageImports` rewrites these to per-file imports at build time.
  // Expected: ~120-200KB saved from initial bundle.
  experimental: {
    optimizePackageImports: ['recharts', 'lucide-react', 'date-fns', '@radix-ui/react-dialog', '@radix-ui/react-select', '@radix-ui/react-popover'],
  },
  // PERF-FASE2-INFRA04: Immutable cache for Next.js static assets.
  // /_next/static/* files are content-hashed (filename changes when content
  // changes), so they're safe to cache forever (1 year). Browser never needs
  // to re-fetch them → 60-80% fewer requests on repeat visits.
  // `immutable` tells browsers/CDNs to NEVER revalidate (no 304 checks).
  async headers() {
    return [
      {
        // Content-hashed static assets — cache forever (immutable)
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
    ];
  },
};

export default nextConfig;
