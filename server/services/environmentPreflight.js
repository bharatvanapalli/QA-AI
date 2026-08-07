'use strict';

const http = require('http');
const https = require('https');

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

const TLS_CERT_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function isTlsCertificateError(err) {
  const code = String(err && (err.code || err.name) || '').trim();
  const message = String(err && err.message || '');
  return TLS_CERT_ERROR_CODES.has(code)
    || /certificate|self[-\s]?signed|unable to get local issuer|unable to verify/i.test(message);
}

function runtimePreflightTlsStrict() {
  const explicit = String(process.env.QAAI_RUNTIME_PREFLIGHT_TLS_STRICT || '').trim();
  if (/^(1|true|yes|on)$/i.test(explicit)) return true;
  if (/^(0|false|no|off)$/i.test(explicit)) return false;
  if (envFlag('QAAI_MCP_TLS_STRICT')) return true;
  return String(process.env.NODE_TLS_REJECT_UNAUTHORIZED || '').trim() === '1';
}

function parseTargetUrl(targetUrl) {
  const raw = clean(targetUrl);
  if (!raw) return { ok: false, code: 'target_url_missing', message: 'No project target URL is configured.' };
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) {
      return { ok: false, code: 'target_url_invalid', message: 'Target URL must use http or https.' };
    }
    return { ok: true, url };
  } catch (_) {
    return { ok: false, code: 'target_url_invalid', message: 'Target URL is not a valid URL.' };
  }
}

function isAuthLikeUrl(url) {
  const text = `${url.pathname || ''} ${url.search || ''}`.toLowerCase();
  return /\b(auth|login|signin|sign-in|sso|oauth|saml|token|session)\b/.test(text);
}

function classifyHttpStatus(statusCode, url) {
  const status = Number(statusCode);
  if (!Number.isFinite(status)) {
    return { ok: false, code: 'target_no_status', retryable: true, message: 'Target did not return an HTTP status.' };
  }
  if (status >= 500 && status <= 599) {
    return { ok: false, code: 'target_http_5xx', retryable: true, message: `Target returned HTTP ${status}; the environment is unavailable.` };
  }
  if (status === 408 || status === 425 || status === 429) {
    return { ok: false, code: 'target_temporarily_unavailable', retryable: true, message: `Target returned HTTP ${status}; the environment is not ready for execution.` };
  }
  if (isAuthLikeUrl(url) && (status === 401 || status === 403 || status === 407 || status === 423)) {
    return { ok: false, code: 'auth_endpoint_rejecting', retryable: true, message: `Auth endpoint returned HTTP ${status}; authentication traffic is being rejected before the test starts.` };
  }
  return { ok: true, code: 'target_reachable', retryable: false, message: `Target pre-flight returned HTTP ${status}; environment is reachable.` };
}

function defaultHttpProbe({ url, method = 'HEAD', timeoutMs = 5000, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const requestOptions = {
      method,
      timeout: Math.max(500, Number(timeoutMs) || 5000),
      headers: {
        'User-Agent': 'QAAI-Runtime-Preflight/2.0',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    };
    if (url.protocol === 'https:') {
      requestOptions.rejectUnauthorized = rejectUnauthorized !== false;
    }
    const req = lib.request(url, requestOptions, (res) => {
      res.resume();
      resolve({ statusCode: res.statusCode, headers: res.headers || {} });
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`Pre-flight timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function preflightTargetEnvironment({
  targetUrl,
  timeoutMs = 5000,
  probe = defaultHttpProbe,
  disabled = envFlag('QAAI_RUNTIME_PREFLIGHT_OFF') || envFlag('QAAI_SKIP_RUNTIME_PREFLIGHT'),
  tlsStrict = runtimePreflightTlsStrict(),
} = {}) {
  const startedAt = Date.now();
  if (disabled) {
    return {
      ok: true,
      skipped: true,
      code: 'preflight_disabled',
      blockedReason: null,
      message: 'Runtime environment pre-flight disabled by configuration.',
      durationMs: 0,
    };
  }

  const parsed = parseTargetUrl(targetUrl);
  if (!parsed.ok) {
    const missing = parsed.code === 'target_url_missing';
    return {
      ok: missing,
      skipped: missing,
      code: parsed.code,
      blockedReason: missing ? null : 'environment_defect',
      message: parsed.message,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    let response = await probe({ url: parsed.url, method: 'HEAD', timeoutMs });
    if ([405, 501].includes(Number(response && response.statusCode))) {
      response = await probe({ url: parsed.url, method: 'GET', timeoutMs });
    }
    const verdict = classifyHttpStatus(response && response.statusCode, parsed.url);
    return {
      ok: verdict.ok,
      skipped: false,
      code: verdict.code,
      blockedReason: verdict.ok ? null : 'environment_defect',
      httpStatus: Number(response && response.statusCode) || null,
      retryable: verdict.retryable,
      targetUrl: parsed.url.toString(),
      message: verdict.message,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (isTlsCertificateError(err) && !tlsStrict && parsed.url.protocol === 'https:') {
      try {
        let response = await probe({ url: parsed.url, method: 'HEAD', timeoutMs, rejectUnauthorized: false });
        if ([405, 501].includes(Number(response && response.statusCode))) {
          response = await probe({ url: parsed.url, method: 'GET', timeoutMs, rejectUnauthorized: false });
        }
        const verdict = classifyHttpStatus(response && response.statusCode, parsed.url);
        if (!verdict.ok) {
          return {
            ok: false,
            skipped: false,
            code: verdict.code,
            blockedReason: 'environment_defect',
            httpStatus: Number(response && response.statusCode) || null,
            retryable: verdict.retryable,
            targetUrl: parsed.url.toString(),
            tlsUnverified: true,
            message: `${verdict.message} TLS issuer verification failed locally, but the target responded when checked with the browser lane's relaxed TLS posture.`,
            durationMs: Date.now() - startedAt,
          };
        }
        return {
          ok: true,
          skipped: false,
          code: 'target_reachable_tls_unverified',
          blockedReason: null,
          httpStatus: Number(response && response.statusCode) || null,
          retryable: false,
          targetUrl: parsed.url.toString(),
          tlsUnverified: true,
          message: `Target responded with HTTP ${Number(response && response.statusCode) || 'unknown'} when TLS issuer verification was relaxed for this QA/corporate certificate. Continuing; this is a portability warning, not a test blocker.`,
          durationMs: Date.now() - startedAt,
        };
      } catch (retryErr) {
        const retryCode = retryErr && (retryErr.code || retryErr.name) ? String(retryErr.code || retryErr.name) : 'probe_error';
        return {
          ok: false,
          skipped: false,
          code: 'target_unreachable',
          blockedReason: 'environment_defect',
          retryable: true,
          targetUrl: parsed.url.toString(),
          message: `Target is unreachable before browser startup after TLS-relaxed retry (${retryCode}: ${clean(retryErr && retryErr.message).slice(0, 240)}).`,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    const errCode = err && (err.code || err.name) ? String(err.code || err.name) : 'probe_error';
    return {
      ok: false,
      skipped: false,
      code: errCode === 'ETIMEDOUT' ? 'target_timeout' : 'target_unreachable',
      blockedReason: 'environment_defect',
      retryable: true,
      targetUrl: parsed.url.toString(),
      message: `Target is unreachable before browser startup (${errCode}: ${clean(err && err.message).slice(0, 240)}).`,
      durationMs: Date.now() - startedAt,
    };
  }
}

module.exports = {
  preflightTargetEnvironment,
  classifyHttpStatus,
  parseTargetUrl,
  isAuthLikeUrl,
  isTlsCertificateError,
  _private: {
    defaultHttpProbe,
    runtimePreflightTlsStrict,
  },
};
