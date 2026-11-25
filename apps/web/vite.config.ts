import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// myinstants.com sends no CORS headers, so the browser reaches it through this local proxy.
// shortcut: only exists in `vite dev`/`vite preview`; a static deploy (GitHub Pages) has no proxy.
const myInstantsProxy = {
  "/mi": {
    target: "https://www.myinstants.com",
    changeOrigin: true,
    followRedirects: true,
    rewrite: (p: string) => p.replace(/^\/mi/, "")
  },
  // Tenor search pages (no CORS). The GIF files on media.tenor.com allow CORS and are fetched directly.
  "/tenor": {
    target: "https://tenor.com",
    changeOrigin: true,
    followRedirects: true,
    rewrite: (p: string) => p.replace(/^\/tenor/, "")
  }
};

// Relative base so the build works at any path (GitHub Pages project site, Netlify, a sub-folder).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: myInstantsProxy,
    // Cloudflare quick tunnels (cloudflared tunnel --url ...) to test on a phone.
    allowedHosts: [".trycloudflare.com"]
  },
  preview: {
    proxy: myInstantsProxy
  },
  resolve: {
    alias: {
      "@stiksound/core": path.resolve(__dirname, "../../packages/core/src/index.ts"),
      "@stiksound/providers": path.resolve(__dirname, "../../packages/providers/src/index.ts"),
      "@stiksound/media-web": path.resolve(__dirname, "../../packages/media-web/src/index.ts"),
      "@stiksound/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
