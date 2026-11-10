import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard runs on :5173 and proxies /api to the API on
// :3000. In production the API serves the built files itself.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: true } } },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] },
});
