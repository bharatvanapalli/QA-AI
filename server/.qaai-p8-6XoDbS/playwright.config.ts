import { defineConfig } from '@playwright/test';

// QAAI ReplayIR export — generated ONLY from RunResult.replayIrJson.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.QAAI_TARGET_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
