'use strict';

/**
 * Universal degradation signal — the antidote to SILENT degradation.
 *
 * The generation pipeline is reliable inside a validated lane (English docs,
 * form-login sites, clean single-header workbooks, auth/RBAC/CRUD domains) and
 * historically degraded SILENTLY outside it: no error, no warning, just
 * quietly-wrong output. That silence — not any single gap — is the primary
 * blocker to universal reliability.
 *
 * Contract: ANY pipeline stage that cannot do its job fully (unparseable or
 * scanned doc, unmapped column, unreachable site, unsupported auth, truncated
 * output, non-English text it cannot understand, …) MUST call recordDegradation
 * instead of returning quietly-wrong data. The signal surfaces to the operator
 * via onLog AND, when a collector array is supplied, as a structured record the
 * route/UI/report can show. Loud-and-honest beats silent-and-wrong.
 *
 *   recordDegradation({ onLog, collector, stage, reason, impact, severity, code })
 *
 * - onLog       (fn)    the agent's WS logger: onLog(level, message). Optional.
 * - collector   (array) pushes a structured record for UI/findings. Optional.
 * - stage       (str)   which pipeline stage degraded (e.g. 'ingestion', 'auth-crawl').
 * - reason      (str)   what went wrong, concretely.
 * - impact      (str)   what the output will therefore lack (so the reviewer can judge trust).
 * - severity    'info' | 'warning' | 'error'  (default 'warning').
 * - code        (str)   stable machine code; derived from stage when omitted.
 *
 * Returns the structured record (also pushed to collector when provided).
 */

const VALID_SEVERITY = new Set(['info', 'warning', 'error']);

function recordDegradation(opts = {}) {
  const { onLog, collector, stage, reason, impact } = opts;
  const severity = VALID_SEVERITY.has(opts.severity) ? opts.severity : 'warning';
  const stageStr = String(stage || 'unknown').trim() || 'unknown';
  const code = opts.code || `degraded_${stageStr.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;

  const record = {
    type: 'generation_degraded',
    code,
    stage: stageStr,
    reason: String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim().slice(0, 400),
    impact: String(impact == null ? '' : impact).replace(/\s+/g, ' ').trim().slice(0, 300),
    severity,
  };

  const msg = `DEGRADED [${record.stage}]: ${record.reason}${record.impact ? ` — impact: ${record.impact}` : ''}`;
  try {
    if (typeof onLog === 'function') {
      const level = severity === 'error' ? 'error' : (severity === 'info' ? 'info' : 'warn');
      const r = onLog(level, msg);
      if (r && typeof r.then === 'function') r.catch(() => {}); // never let logging break a stage
    }
  } catch (_) { /* logging must never throw */ }

  if (Array.isArray(collector)) collector.push(record);
  return record;
}

/**
 * Convenience: true when a value is missing/blank — the most common reason a
 * stage degrades (empty extracted text, no rows, unmapped column).
 */
function isEffectivelyEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

module.exports = { recordDegradation, isEffectivelyEmpty };
