import { describe, expect, it } from 'vitest';
import preflight from '../../server/services/environmentPreflight.js';

describe('runtime environment pre-flight', () => {
  it('skips cleanly when no target URL is configured', async () => {
    const result = await preflight.preflightTargetEnvironment({ targetUrl: '' });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.code).toBe('target_url_missing');
  });

  it('treats a normal protected base URL as reachable', () => {
    const url = new URL('https://example.test/private');

    const verdict = preflight.classifyHttpStatus(403, url);

    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe('target_reachable');
  });

  it('classifies auth endpoint rejection as an environment defect', () => {
    const url = new URL('https://example.test/auth/login');

    const verdict = preflight.classifyHttpStatus(403, url);

    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('auth_endpoint_rejecting');
  });

  it('classifies service outages before browser startup', async () => {
    const result = await preflight.preflightTargetEnvironment({
      targetUrl: 'https://example.test/',
      probe: async () => ({ statusCode: 503 }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe('environment_defect');
    expect(result.code).toBe('target_http_5xx');
    expect(result.message).toContain('environment is unavailable');
  });

  it('falls back from unsupported HEAD to GET', async () => {
    const calls = [];
    const result = await preflight.preflightTargetEnvironment({
      targetUrl: 'https://example.test/',
      probe: async ({ method }) => {
        calls.push(method);
        return { statusCode: method === 'HEAD' ? 405 : 200 };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['HEAD', 'GET']);
  });

  it('classifies DNS/connectivity errors as retryable environment defects', async () => {
    const result = await preflight.preflightTargetEnvironment({
      targetUrl: 'https://example.test/',
      probe: async () => {
        const err = new Error('getaddrinfo ENOTFOUND example.test');
        err.code = 'ENOTFOUND';
        throw err;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.blockedReason).toBe('environment_defect');
    expect(result.code).toBe('target_unreachable');
  });

  it('treats local TLS issuer failures as advisory when the browser lane allows relaxed TLS', async () => {
    const calls = [];
    const result = await preflight.preflightTargetEnvironment({
      targetUrl: 'https://example.test/',
      tlsStrict: false,
      probe: async ({ rejectUnauthorized }) => {
        calls.push(rejectUnauthorized);
        if (rejectUnauthorized !== false) {
          const err = new Error('unable to get local issuer certificate');
          err.code = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';
          throw err;
        }
        return { statusCode: 200 };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('target_reachable_tls_unverified');
    expect(result.tlsUnverified).toBe(true);
    expect(calls).toEqual([undefined, false]);
  });

  it('keeps TLS issuer failures blocking when runtime preflight strict TLS is requested', async () => {
    const result = await preflight.preflightTargetEnvironment({
      targetUrl: 'https://example.test/',
      tlsStrict: true,
      probe: async () => {
        const err = new Error('unable to get local issuer certificate');
        err.code = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';
        throw err;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('target_unreachable');
    expect(result.blockedReason).toBe('environment_defect');
  });
});
