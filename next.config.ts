import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No standalone — use regular next start (more reliable on Railway)
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
