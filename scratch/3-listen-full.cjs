const WebSocket = require('ws');

const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhNWQ5MTZjZC00MTc4LTRiY2MtYjQwOS1jODg1YTM4OWU4NDMiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODYzNDQ1OTB9.xXeQ0H_qRAjMxJDgeSGog6UIi7TXm9HBynx0G-5Ihrg';
const DURATION_MS = Number(process.argv[2] || 600000);

const ws = new WebSocket('ws://localhost:5000', {
  headers: { Cookie: `token=${AUTH_TOKEN}` },
});

ws.on('open', () => console.log('[listener] connected'));
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
  if (msg.type === 'agent.phase.log') {
    console.log(`[LOG][${msg.phase}][${msg.level}] ${msg.message}`);
  } else if (msg.type === 'agent.phase.start') {
    console.log(`[PHASE-START] ${msg.phase} attempt=${msg.attempt}`);
  } else if (msg.type === 'agent.phase.complete') {
    console.log(`[PHASE-COMPLETE] ${msg.phase} error=${msg.error || ''}`);
  } else if (msg.type === 'run.complete') {
    console.log(`[RUN-COMPLETE] runId=${msg.runId} summary=${JSON.stringify(msg.summary)}`);
  } else if (msg.type === 'run.counters') {
    console.log(`[COUNTERS] passed=${msg.passed} failed=${msg.failed} blocked=${msg.blocked}`);
  } else if (msg.type === 'controller.progress' && msg.reason && msg.reason.includes('LADDER_DEBUG')) {
    console.log(`[LADDER-DEBUG] op=${msg.operationId} adapterKind=${msg.adapterKind} ladderIndex=${msg.ladderIndex} positivelyNotDelivered=${msg.positivelyNotDelivered} proofStatus=${msg.proofStatus}`);
  } else if (msg.type === 'controller.progress' && msg.reason === 'strategy_mismatch_escalating_ladder') {
    console.log(`[LADDER-ESCALATE] op=${msg.operationId} from=${msg.fromAdapterKind} to=${msg.toAdapterKind} index=${msg.ladderIndex}`);
  }
});
ws.on('error', (err) => console.error('[listener] error', err.message));

setTimeout(() => { ws.close(); process.exit(0); }, DURATION_MS);
