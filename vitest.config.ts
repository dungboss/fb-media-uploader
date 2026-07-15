import path from "node:path";

import { defineConfig } from "vitest/config";

// Minimal config: node environment only (no React/DOM tests), `@/` alias
// matching tsconfig.json. No coverage config, no setup files.
export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
