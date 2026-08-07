require('dotenv').config();
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const runId = process.argv[2];
const durationMs = Math.max(5_000, Number(process.argv[3]) || 30_000);
if (!runId) throw new Error('runId is required');

const token = jwt.sign({
  sub: 'a5d916cd-4178-4bcc-b409-c885a389e843',
  email: 'bharatvanapalli8@gmail.com',
  role: 'user',
}, process.env.JWT_SECRET, { expiresIn: '10m' });

const ws = new WebSocket('ws://127.0.0.1:5000/ws', {
  headers: { cookie: `token=${token}` },
});
const interesting = new Set([
  'step.start', 'step.progress', 'step.complete', 'step.operationCheck',
  'browser.action', 'result', 'run.counters', 'run.complete',
]);

ws.on('message', (raw) => {
  let message;
  try { message = JSON.parse(raw.toString()); } catch (_) { return; }
  if (message.runId !== runId || !interesting.has(message.type)) return;
  const compact = {
    type: message.type,
    tcId: message.tcId,
    stepIndex: message.stepIndex,
    totalSteps: message.totalSteps,
    status: message.status,
    tool: message.tool,
    target: message.args?.element || message.args?.target || message.args?.ref,
    reason: message.error || message.reason || message.operationCheck?.reason,
  };
  console.log(JSON.stringify(compact));
});

ws.on('error', (error) => {
  console.error(`WS_ERROR:${error.message}`);
  process.exitCode = 1;
});

setTimeout(() => ws.close(), durationMs);
ws.on('close', () => process.exit());
