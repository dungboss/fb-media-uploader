import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["bullmq", "ioredis"],
  experimental: {
    // Local-folder files pass through proxy.ts before reaching their Route
    // Handler. Keep this slightly above the default 100MB OOM guard so the
    // multipart envelope is not truncated by Next's proxy body clone.
    proxyClientMaxBodySize: "110mb",
  },
};

export default nextConfig;
