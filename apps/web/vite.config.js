import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the UI is served by Vite and /api is proxied to the API, so the browser sees ONE origin
// (cookies, CSRF and OAuth redirects behave exactly as in production behind the nginx container).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 700 },
});
