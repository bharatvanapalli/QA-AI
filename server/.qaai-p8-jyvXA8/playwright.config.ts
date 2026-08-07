import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function loadQaaEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Always override: the exported .env is the ground truth for this package.
    // Without this, a stale QAAI_TARGET_URL in the parent shell would silently
    // shadow the run-specific URL, causing the preflight to hit the wrong site.
    process.env[key] = value;
  }
}

loadQaaEnv();

// QAAI ReplayIR export — generated ONLY from RunResult.replayIrJson.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // Serial + one retry. These specs can share live-site state (a case that
  // creates data a later case consumes) and demo environments degrade under
  // parallel load — running one-at-a-time with a retry removes the #1 cause of
  // "passes solo, fails in a batch" flakiness, which is NOT a code defect.
  workers: 1,
  retries: 1,
  // Fail loud and clear when the target site itself is unreachable, so a down
  // environment is never mistaken for a broken script.
  globalSetup: './qaai.preflight.js',
  reporter: 'list',
  use: {
    baseURL: process.env.QAAI_TARGET_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
