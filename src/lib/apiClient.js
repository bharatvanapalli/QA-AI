/**
 * QAAI API client.
 * - All requests credentialed (cookies sent).
 * - All mutating requests automatically attach X-XSRF-TOKEN from the cookie.
 * - 401 triggers a single refresh attempt; on second 401 the user is signed out.
 * - Errors throw an ApiError with .code/.status/.payload for the caller to surface.
 *
 * Two consumption styles are supported:
 *
 *   1. Classic (throws): `await api.get('/foo')` — throws ApiError on non-2xx.
 *      All existing call sites use this and continue to work unchanged.
 *
 *   2. Safe (`api.safe.*`): `const { ok, data, error } = await api.safe.get('/foo')`
 *      — never throws; returns a normalised result tuple so callers can write
 *      flat `if (!ok) toast.error(error.message)` style code without nested
 *      try/catch. Use this in new code to centralise the error-handling
 *      pattern that was previously duplicated across every page.
 */

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export class ApiError extends Error {
  constructor(status, payload, opts = {}) {
    const message =
      // Prefer the server's friendly message, then the network-level message
      // (`opts.cause?.message`), then a generic fallback. Never expose `[object Object]`.
      payload?.message ||
      opts.cause?.message ||
      (status ? `HTTP ${status}` : 'Network error');
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.code = payload?.code || opts.code || 'UNKNOWN';
    this.payload = payload || {};
    if (opts.cause) this.cause = opts.cause;
  }

  /**
   * Best-effort user-friendly message for toasts. Falls back through the
   * server's `message` → server's `error` → the generic Error.message.
   */
  toUserMessage() {
    return (
      this.payload?.message ||
      this.payload?.error ||
      this.message ||
      'Something went wrong. Please try again.'
    );
  }

  /** True for connectivity failures (server unreachable, DNS, CORS, abort). */
  get isNetwork() { return this.status === 0; }
  /** True for auth failures the user can resolve by signing in again. */
  get isAuth() { return this.status === 401 || this.status === 403; }
  /** True for server-side issues out of the user's control. */
  get isServer() { return this.status >= 500 && this.status < 600; }
}

/**
 * Normalise *anything* a catch block might receive into an ApiError so the
 * UI never sees a bare Error / TypeError / object. Idempotent: passing an
 * existing ApiError through returns it unchanged.
 */
export function normaliseError(err) {
  if (err instanceof ApiError) return err;
  if (err && err.name === 'AbortError') {
    return new ApiError(0, { code: 'ABORTED', message: 'Request cancelled.' }, { cause: err, code: 'ABORTED' });
  }
  if (err instanceof Error) {
    return new ApiError(0, { code: 'NETWORK', message: err.message }, { cause: err, code: 'NETWORK' });
  }
  // Plain object thrown / Promise.reject(string) / etc.
  const msg = typeof err === 'string' ? err : 'Unknown error';
  return new ApiError(0, { code: 'UNKNOWN', message: msg });
}

function readCookie(name) {
  const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]) : '';
}

let refreshPromise = null;

async function attemptRefresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function request(path, { method = 'GET', body, signal, _retried = false } = {}) {
  const headers = { Accept: 'application/json' };
  let bodyToSend;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyToSend = JSON.stringify(body);
  }
  if (!['GET', 'HEAD'].includes(method)) {
    const xsrf = readCookie('XSRF-TOKEN');
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
  }

  let resp;
  try {
    resp = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: bodyToSend,
      credentials: 'include',
      signal,
    });
  } catch (err) {
    // Network-level failure: DNS, server down, CORS, abort. Surface as an
    // ApiError with status=0 so callers can branch on `err.isNetwork`.
    throw normaliseError(err);
  }

  // Auto-refresh on 401 once
  if (resp.status === 401 && !_retried && !path.startsWith('/auth/')) {
    const refreshed = await attemptRefresh();
    if (refreshed) {
      return request(path, { method, body, signal, _retried: true });
    }
  }

  let payload = null;
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    payload = await resp.json().catch(() => null);
  } else {
    payload = null;
  }

  if (!resp.ok) throw new ApiError(resp.status, payload);
  return payload;
}

/**
 * Safe wrapper — never throws. Returns `{ ok: true, data }` on success or
 * `{ ok: false, error }` on failure, where `error` is always an ApiError.
 * Use from call sites that would otherwise write boilerplate try/catch +
 * `toast.error(err.message)` blocks; this centralises the normalisation.
 */
async function safeCall(method, path, body, opts) {
  try {
    const data = await request(path, { ...opts, method, body });
    return { ok: true, data, error: null };
  } catch (err) {
    return { ok: false, data: null, error: normaliseError(err) };
  }
}

const api = {
  get: (p, opts) => request(p, { ...opts, method: 'GET' }),
  post: (p, body, opts) => request(p, { ...opts, method: 'POST', body }),
  put: (p, body, opts) => request(p, { ...opts, method: 'PUT', body }),
  patch: (p, body, opts) => request(p, { ...opts, method: 'PATCH', body }),
  del: (p, opts) => request(p, { ...opts, method: 'DELETE' }),

  // Safe variants — return { ok, data, error } instead of throwing.
  safe: {
    get: (p, opts) => safeCall('GET', p, undefined, opts),
    post: (p, body, opts) => safeCall('POST', p, body, opts),
    put: (p, body, opts) => safeCall('PUT', p, body, opts),
    patch: (p, body, opts) => safeCall('PATCH', p, body, opts),
    del: (p, opts) => safeCall('DELETE', p, undefined, opts),
  },

  // ── Auth ─────────────────────────────────────────────────
  signup: (data) => request('/auth/signup', { method: 'POST', body: data }),
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  csrfToken: () => request('/auth/csrf-token'),
};

export default api;
export { BASE_URL };
