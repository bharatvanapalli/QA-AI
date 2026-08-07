function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function alignLoopbackUrlWithPage(url, fallback, pageLocation = null) {
  const raw = url || fallback;
  const location = pageLocation || (typeof window !== 'undefined' ? window.location : null);
  if (!raw || !location) return raw;

  try {
    const target = new URL(raw);
    const pageHost = location.hostname;
    if (!isLoopbackHost(pageHost) || !isLoopbackHost(target.hostname)) return raw;
    if (target.hostname === pageHost) return raw;

    target.hostname = pageHost;
    return target.toString().replace(/\/$/, raw.endsWith('/') ? '/' : '');
  } catch {
    return raw;
  }
}
