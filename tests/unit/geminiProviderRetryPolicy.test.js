// @vitest-environment node

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const gemini = require('../../server/lib/providers/gemini');

function successResponse(text = 'ok') {
  return {
    response: {
      candidates: [{
        content: { parts: [{ text }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  };
}

function installFakeGenerate(generateContent) {
  class FakeGoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent };
    }
  }
  gemini.__test__.setGoogleGenerativeAI(FakeGoogleGenerativeAI);
}

function complete(overrides = {}) {
  return gemini.complete({
    apiKey: 'test-key',
    model: 'gemini-test',
    system: '',
    messages: [],
    maxTokens: 100,
    ...overrides,
  });
}

afterEach(() => {
  gemini.__test__.setGoogleGenerativeAI(null);
  vi.restoreAllMocks();
});

describe('Gemini per-request retry policy', () => {
  it('performs one physical attempt when Add Scenario passes maxRetries: 0', async () => {
    const generateContent = vi.fn().mockRejectedValue(
      new Error('[429 Too Many Requests] Please retry in 0s'),
    );
    installFakeGenerate(generateContent);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(complete({ maxRetries: 0, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(gemini.__test__.requestPolicy({ maxRetries: 0, timeoutMs: 1_000 }))
      .toEqual({ maxRetries: 0, maxAttempts: 1, timeoutMs: 1_000 });
  });

  it('preserves the existing default of one bounded retry for other callers', async () => {
    const generateContent = vi.fn()
      .mockRejectedValueOnce(new Error('[429 Too Many Requests] Please retry in 0s'))
      .mockResolvedValueOnce(successResponse('recovered'));
    installFakeGenerate(generateContent);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await complete();

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(response.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(gemini.__test__.requestPolicy())
      .toEqual({ maxRetries: 1, maxAttempts: 2, timeoutMs: null });
  });

  it('aborts a physical request at the caller-provided deadline', async () => {
    const generateContent = vi.fn((_request, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }));
    installFakeGenerate(generateContent);

    await expect(complete({ maxRetries: 0, timeoutMs: 5 }))
      .rejects.toMatchObject({ code: 'GEMINI_TIMEOUT', status: 504 });

    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
