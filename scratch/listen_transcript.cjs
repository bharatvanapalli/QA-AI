const WebSocket = require('ws');

const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhNWQ5MTZjZC00MTc4LTRiY2MtYjQwOS1jODg1YTM4OWU4NDMiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODYzNDQyNTB9.1aZQl4QHvtN9Ebq5qdgA29_FbHB6RIi50XTlPfcDX5c';
const DURATION_MS = Number(process.argv[2] || 170000);

const ws = new WebSocket('ws://localhost:5000', {
  headers: { Cookie: `token=${AUTH_TOKEN}` },
});

ws.on('open', () => console.log('[listener] connected'));
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
  if (msg.type === 'browser.action') {
    console.log(`[ACTION] tool=${msg.tool} status=${msg.actionStatus} narration="${msg.narration}"`);
  } else if (msg.type === 'controller.proof-diagnostic') {
    console.log(`[DIAGNOSTIC] message=${msg.message} name=${msg.name} role=${msg.role}`);
  } else if (msg.type === 'controller.resolution-diagnostic') {
    console.log(`[RESOLUTION] operationId=${msg.operationId} status=${msg.resolutionStatus} reason=${msg.reason} target=${JSON.stringify(msg.target)} candidateCount=${msg.candidateCount}`);
  }
});
ws.on('error', (err) => console.error('[listener] error', err.message));

setTimeout(() => { ws.close(); process.exit(0); }, DURATION_MS);
