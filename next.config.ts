import type { NextConfig } from "next";
// PERF-FASE4-ANALYZER: Bundle analyzer wraps nextConfig to visualize
// JS bundle composition. Run with: ANALYZE=true bun run build
// Opens a treemap at .next/analyze/client.html showing which modules
// take the most space — helps identify dead code, duplicate imports,
// and heavy dependencies that could be lazy-loaded.
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  // EXPORT-PDF: pdfkit reads its .afm font-metric files from node_modules at
  // runtime (fs + __dirname) — keeping it external (not webpack-bundled)
  // preserves those file reads in every deployment target (Vercel/Railway).
  serverExternalPackages: ['pdfkit'],
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
  // PERF-FE: extended to cover ALL Radix primitives used by the shadcn/ui
  // component set (29 ui components). Each Radix package barrel-exports
  // 5-10 primitives — without this, importing e.g. <Tooltip> from
  // @radix-ui/react-tooltip pulls the package's full graph even though
  // only 4 primitives are used. Adding these is a low-risk, build-time-only
  // optimization that shaves a few KB per Radix package.
  experimental: {
    optimizePackageImports: [
      'recharts',
      'lucide-react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-select',
      '@radix-ui/react-popover',
      '@radix-ui/react-tooltip',
      '@radix-ui/react-tabs',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-switch',
      '@radix-ui/react-slider',
      '@radix-ui/react-label',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-progress',
      '@radix-ui/react-toast',
      // PERF-FIX: removed @prisma/client (server-only, no client benefit),
      // chroma-js (not installed, phantom), date-fns (not directly imported).
    ],
  },
  // PERF-FASE2-INFRA04: Immutable cache for Next.js static assets.
  // /_next/static/* files are content-hashed in PRODUCTION (filename changes
  // when content changes), so they're safe to cache forever (1 year). Browser
  // never needs to re-fetch them → 60-80% fewer requests on repeat visits.
  // `immutable` tells browsers/CDNs to NEVER revalidate (no 304 checks).
  //
  // AUDIT-CACHE (P1 FIX): In Turbopack DEV mode, chunk filenames use a STABLE
  // module-ID hash (e.g. `AreaItemHeatmap_tsx_022dtko._.js`), NOT a content
  // hash. The URL stays the same after a source edit — only the file content
  // changes. If we send `immutable` in dev, the browser caches the FIRST
  // version of each chunk URL and never re-fetches, so source edits never
  // reach the browser until the cache entry expires (1 year). This is exactly
  // why "old versions keep appearing" despite source updates.
  //
  // The headers() function runs in both dev and prod, so we MUST gate this
  // rule on NODE_ENV === 'production'. In dev, we OMIT the rule entirely so
  // Turbopack's default `no-cache` headers apply AND Next.js's "Custom
  // Cache-Control detected" warning is silenced. The catch-all /(.*) rule
  // below does NOT set Cache-Control, so it doesn't interfere with Turbopack's
  // defaults on /_next/static/* in dev.
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    const staticAssetRules = isProd
      ? [{
          // PROD ONLY: Content-hashed static assets — cache forever (immutable)
          source: '/_next/static/(.*)',
          headers: [
            { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          ],
        }]
      : []; // DEV: omit rule → Turbopack's default no-cache applies
    return [
      ...staticAssetRules,
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // DS-10 + SEC-06: Content-Security-Policy — prevents XSS, injection, exfiltration.
          // Production: 'unsafe-inline' only (no unsafe-eval). Dev: allows unsafe-eval for HMR.
          { key: 'Content-Security-Policy', value: process.env.NODE_ENV === 'production'
            ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
            : "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
          },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
