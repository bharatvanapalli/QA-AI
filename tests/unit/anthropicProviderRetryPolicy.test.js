import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const anthropic = require('../../server/lib/providers/anthropic');

describe('Anthropic provider per-request retry policy', () => {
  it('honors Add Scenario no-retry and remaining-deadline options', () => {
    const options = anthropic.__test__.streamClientOptions('test-only-key', {
      timeoutMs: 89_000,
      maxRetries: 0,
    });

    expect(options).toEqual(expect.objectContaining({
      apiKey: 'test-only-key',
      timeout: 89_000,
      maxRetries: 0,
    }));
  });

  it('preserves the existing bounded stream defaults for other callers', () => {
    const options = anthropic.__test__.streamClientOptions('test-only-key');

    expect(options).toEqual(expect.objectContaining({
      timeout: 600_000,
      maxRetries: 1,
    }));
  });
});
