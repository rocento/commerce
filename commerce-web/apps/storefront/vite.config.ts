import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { compressedAssets } from './build-compression';
import { homeThemeWarmup } from './build-warmup';
import { criticalStorefrontStyles } from './build-critical-styles';
export default defineConfig({
  build: { rollupOptions: { input: { app: "index.html", public: "public.html" } } },
  plugins: [react(), homeThemeWarmup(), criticalStorefrontStyles(), compressedAssets(), { name: 'health', configureServer(server) {
    server.middlewares.use('/health', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok' })); });
  } }],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:8080',
        changeOrigin: true,
        headers: { Origin: process.env.API_PROXY_ORIGIN || 'http://localhost:5173' },
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  },
});
