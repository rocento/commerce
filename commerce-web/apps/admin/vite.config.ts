import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react(), { name: 'health', configureServer(server) {
    server.middlewares.use('/health', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok' })); });
  } }],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:8080',
        changeOrigin: true,
        headers: { Origin: process.env.API_PROXY_ORIGIN || 'http://localhost:5174' },
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  },
});
