import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@stiksound/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@stiksound/providers": path.resolve(__dirname, "packages/providers/src/index.ts"),
      "@stiksound/media-web": path.resolve(__dirname, "packages/media-web/src/index.ts"),
      "@stiksound/ui": path.resolve(__dirname, "packages/ui/src/index.ts")
    }
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.tsx",
      "apps/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.tsx",
      "netlify/**/*.test.ts"
    ],
    environment: "node"
  }
});
