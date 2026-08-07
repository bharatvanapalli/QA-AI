'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const WebSocket = require('../server/node_modules/ws');

const token = jwt.sign({
  sub: 'a5d916cd-4178-4bcc-b409-c885a389e843',
  email: 'bharatvanapalli8@gmail.com',
  role: 'user',
}, process.env.JWT_SECRET, { expiresIn: '10m' });
const ws = new WebSocket('ws://127.0.0.1:5000/ws', { headers: { Cookie: `token=${token}` } });
const wantedProject = '1582559f-364f-4d0e-bfde-fd18832fdaa7';
const startedAt = Date.now();
const interestingLog = /step|calendar|date|time|dispatch|journal|blocked|failed|conductor|tool|action/i;
const diagnosticOnly = process.env.QAAI_ODYSSEY_DIAGNOSTIC_ONLY === '1';

ws.on('message', (raw) => {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  if (message.projectId && message.projectId !== wantedProject) return;
  const type = String(message.type || 'unknown');
  const detail = String(message.message || message.error || message.reason || '');
  if (diagnosticOnly && !/^(?:step\.|case\.|run\.|controller\.(?:proof-diagnostic|progress|recovery))/.test(type)) return;
  if (!/run|step|tool|action|case|conductor|controller|snapshot/i.test(type) && !interestingLog.test(detail)) return;
  const compact = {
    ms: Date.now() - startedAt,
    type,
    runId: message.runId || null,
    tcId: message.tcId || null,
    stepIndex: message.stepIndex ?? null,
    phase: message.phase || null,
    status: message.status || null,
    tool: message.tool || message.toolName || null,
    message: detail.slice(0, 500) || null,
    url: message.url || null,
    title: message.title || null,
    candidateCount: Number.isFinite(message.candidateCount) ? message.candidateCount : null,
    snapshotCharCount: Number.isFinite(message.snapshotCharCount) ? message.snapshotCharCount : null,
    snapshotLineCount: Number.isFinite(message.snapshotLineCount) ? message.snapshotLineCount : null,
    snapshotPreview: message.snapshotPreview || null,
    candidates: Array.isArray(message.candidates)
      ? message.candidates.slice(0, 40).map((candidate) => ({
        ref: candidate.ref || null,
        role: candidate.role || null,
        name: candidate.name || null,
        section: candidate.section || null,
      }))
      : null,
  };
  console.log(JSON.stringify(compact));
});
ws.on('error', (error) => console.error(`WS_ERROR ${error.message}`));
const boundedWatchMs = Math.max(
  40_000,
  Math.min(50_000, Number(process.env.QAAI_ODYSSEY_WATCH_MS) || 45_000),
);
setTimeout(() => {
  try { ws.close(); } catch (_) {}
  process.exit(0);
}, boundedWatchMs);
