import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "health",
      configureServer(server) {
        server.middlewares.use("/health", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end('{"status":"ok"}');
        });
      },
    },
  ],
  server: {
    port: 5194,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://localhost:8080",
        changeOrigin: true,
        headers: {
          Origin: process.env.API_PROXY_ORIGIN || "http://localhost:5194",
        },
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    headers: {
      // Match the production mobile vhost so browser tests catch CSP regressions.
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    },
  },
});
