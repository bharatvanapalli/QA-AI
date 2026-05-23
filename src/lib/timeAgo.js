// Relative-time formatter for run timestamps, banner age, etc. Extracted
// from Theater.jsx so other pages (Reports, Overview, LastRunSummary)
// share one rounding policy.
//
// Accepts a Date OR a millisecond epoch OR an ISO string — the API client
// hands us ISO strings from the server and `new Date(...)` is happy with
// both Date and number; one helper, three call sites.
export function timeAgo(input) {
  const date = input instanceof Date ? input : new Date(input);
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
