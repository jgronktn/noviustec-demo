import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { execSync } from "node:child_process";

// Capture the git SHA + build timestamp at build time so the UI can show
// "what's actually serving" instead of a stale hardcoded version string.
// Falls back to "dev" if git isn't reachable (e.g. CI builds outside a repo).
function gitInfo() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim().length > 0;
    return dirty ? `${sha}+` : sha;
  } catch {
    return "dev";
  }
}

// Dev server proxies /api/* and /webhooks/* to the local backend so the
// frontend can use relative URLs (matches the same-origin pattern in prod
// where nginx routes both apex domains through the same TLS termination).
//
// Production: build with VITE_API_URL=https://api-demo.noviustec.com (set in
// .env.production) so the bundled JS hits the real backend.
export default defineConfig({
  plugins: [vue()],
  define: {
    __BUILD_SHA__: JSON.stringify(gitInfo()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/webhooks": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
  build: {
    sourcemap: true,
  },
});
