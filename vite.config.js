import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
// This token is supplied by start_all.py only to the local Vite process.  The
// proxy adds it on requests to the loopback controller, so it never becomes a
// VITE_* value bundled into browser code.
const uc3ControllerToken = process.env.UC3_CONTROLLER_TOKEN || "";

export default defineConfig({
  root: path.join(rootDir, "client"),
  envDir: rootDir,
  publicDir: false,
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/uc3": {
        target: "http://127.0.0.1:8765",
        changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => {
            if (uc3ControllerToken) proxyRequest.setHeader("X-UC3-Session", uc3ControllerToken);
          });
        },
      },
    },
  },
  build: {
    outDir: path.join(rootDir, "dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@app": path.join(rootDir, "client/src/app"),
      "@features": path.join(rootDir, "client/src/features"),
      "@shared": path.join(rootDir, "client/src/shared"),
      "@brand": path.join(rootDir, "client/assets/brand"),
    },
  },
});
