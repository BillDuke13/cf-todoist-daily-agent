import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/plan",
        destination: "/api/plan",
      },
    ];
  },
};

export default nextConfig;

// Enable `getCloudflareContext()` in `next dev`
initOpenNextCloudflareForDev();
