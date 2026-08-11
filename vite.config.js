import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
        ws: true,
      },
    },
    // The Conductor writes Playwright spec files, screenshots, traces, and
    // telemetry into these directories mid-run. Without explicit ignores,
    // chokidar fires "add" events and Vite's HMR fallback can decide to do a
    // full page reload — which wipes the live pipeline animation, the action
    // trail, and the WS subscription mid-run. The user hit this exact symptom
    // after the first test case completed (when the Playwright project shell
    // is first scaffolded under playwright/runs/<runId>/). Ignoring these
    // paths makes the dev server treat them as artifacts, not source.
    watch: {
      ignored: [
        '**/playwright/**',
        '**/.screenshots/**',
        '**/output-files/**',
        '**/governance/**',
        '**/dev.db',
        '**/dev.db-journal',
        '**/prisma/migrations/**',
      ],
    },
  },
  build: {
    sourcemap: true,
  },
});
