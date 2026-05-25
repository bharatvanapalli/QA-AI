'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const { notFound, errorHandler } = require('./middleware/error');
const prisma = require('./prisma');

const authRoutes = require('./routes/auth');
const claudeRoutes = require('./routes/settings.claude');
const geminiRoutes = require('./routes/settings.gemini');
const adoRoutes = require('./routes/settings.ado');
const jiraRoutes = require('./routes/settings.jira');
const webhookRoutes = require('./routes/settings.webhook');
const notificationsRoutes = require('./routes/settings.notifications');
const projectsRoutes = require('./routes/projects');
const requirementsRoutes = require('./routes/requirements');
const testCasesRoutes = require('./routes/testCases');
const scenariosRoutes = require('./routes/scenarios');
const agentsRoutes = require('./routes/agents');
const runsRoutes = require('./routes/runs');
const reporterRoutes = require('./routes/reporter');
const analystRoutes = require('./routes/analyst');
const knowledgeBaseRoutes = require('./routes/knowledgeBase');
const governanceRoutes = require('./routes/governance');
const blockedRoutes = require('./routes/blocked');
const outputFilesRoutes = require('./routes/outputFiles');
const dashboardRoutes = require('./routes/dashboard');
const sprintsRoutes = require('./routes/sprints');
const budgetRoutes = require('./routes/budget');

const { PLAYWRIGHT_DIR } = require('./playwright-worker');

const PORT = Number(process.env.PORT || 5000);
const ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('[server] JWT_SECRET missing. Set it in .env.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Health
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: 'up', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

// Static Playwright artifacts (auth-gated could be added later via signed URLs)
app.use('/artifacts', express.static(path.join(PLAYWRIGHT_DIR, 'test-results')));
app.use('/report', express.static(path.join(PLAYWRIGHT_DIR, 'playwright-report')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/settings/claude', claudeRoutes);
app.use('/api/settings/gemini', geminiRoutes);
app.use('/api/settings/ado', adoRoutes);
app.use('/api/settings/jira', jiraRoutes);
app.use('/api/settings/webhook', webhookRoutes);
app.use('/api/settings/notifications', notificationsRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/projects/:projectId/requirements', requirementsRoutes);
app.use('/api/projects/:projectId/test-cases', testCasesRoutes);
app.use('/api/projects/:projectId/scenarios', scenariosRoutes);
app.use('/api/projects/:projectId/agents', agentsRoutes);
app.use('/api/projects/:projectId', analystRoutes);
app.use('/api/projects/:projectId/knowledge-base', knowledgeBaseRoutes);
app.use('/api/projects/:projectId/governance', governanceRoutes);
app.use('/api/projects/:projectId/blocked', blockedRoutes);
app.use('/api/projects/:projectId/sprints', sprintsRoutes);
app.use('/api/projects/:projectId/output-files', outputFilesRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/runs', reporterRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/budget', budgetRoutes);

app.use(notFound);
app.use(errorHandler);

const server = http.createServer(app);

// ── Authenticated WebSocket (token via cookie) ───────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Parse cookies manually — no Express middleware on upgrade
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((s) => s.trim().split('='))
      .filter((pair) => pair.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
  const token = cookies.token;
  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = payload.sub;
      wss.emit('connection', ws, req);
    });
  });
});

const userSockets = new Map(); // userId -> Set<ws>

wss.on('connection', (ws) => {
  const set = userSockets.get(ws.userId) || new Set();
  set.add(ws);
  userSockets.set(ws.userId, set);
  ws.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));

  ws.on('close', () => {
    const s = userSockets.get(ws.userId);
    if (s) {
      s.delete(ws);
      if (!s.size) userSockets.delete(ws.userId);
    }
  });
});

// Broadcast helper — scoped to a user
function broadcastToUser(userId, message) {
  const set = userSockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
app.locals.broadcastToUser = broadcastToUser;

// ── Stale-run reaper ─────────────────────────────────────────
// Any Run still in 'running' state more than STALE_RUN_MAX_MIN minutes
// after startedAt is orphaned — usually because the server died mid-run
// or the user closed the browser before the pipeline emitted run.complete.
// Without this, the UI shows runs as RUNNING forever after a crash.
//
// Status flipped to 'cancelled' (not 'failed') so the recommendation engine
// and Reports list distinguish "user/system stopped this" from "real test
// failures" — both look red but mean different things to the QA lead.
const STALE_RUN_MAX_MIN = Number(process.env.QAAI_STALE_RUN_MAX_MIN || 30);
const REAPER_INTERVAL_SEC = Number(process.env.QAAI_REAPER_INTERVAL_SEC || 30);
async function reapStaleRuns() {
  const cutoff = new Date(Date.now() - STALE_RUN_MAX_MIN * 60_000);
  try {
    const result = await prisma.run.updateMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    if (result.count > 0) {
      console.log(`[server] reaper: marked ${result.count} stale run(s) as cancelled (idle > ${STALE_RUN_MAX_MIN} min)`);
    }
    // Same treatment for test cases left in 'running' state — they belong
    // to runs that never finished, so the user sees them stuck forever on
    // the Test Cases page.
    const tcResult = await prisma.testCase.updateMany({
      where: { status: 'running', updatedAt: { lt: cutoff } },
      data: { status: 'pending' },
    });
    if (tcResult.count > 0) {
      console.log(`[server] reaper: reset ${tcResult.count} stuck test case(s) from running → pending`);
    }
  } catch (err) {
    console.error('[server] reaper failed:', err.message);
  }
}

const sessionRegistry = require('./services/sessionRegistry');
const cancelRegistry = require('./services/cancelRegistry');

let reaperHandle = null;
let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting new connections, abort any in-flight
 * Claude calls (via cancelRegistry), tear down MCP browser sessions, close
 * the HTTP server, disconnect Prisma, exit.
 *
 * Without this, Ctrl-C on the dev server left Chromium child processes
 * holding the CDP port — the next dev:full start would EADDRINUSE on the
 * MCP side and look like a flaky port collision.
 */
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — graceful shutdown starting`);

  if (reaperHandle) clearInterval(reaperHandle);

  // Stop accepting new connections, but keep existing ones for the WS
  // close handshake during the next steps.
  server.close((err) => {
    if (err) console.error('[server] http close error:', err.message);
  });

  // Abort all in-flight Claude/agent calls — token controllers are wired
  // into the Anthropic SDK signal, so the HTTP requests close immediately.
  for (const [userId, token] of cancelRegistry.tokens) {
    try { token.controller?.abort(); } catch (_) {}
    cancelRegistry.tokens.delete(userId);
  }

  // Tear down every MCP / Playwright browser session so Chromium child
  // processes exit cleanly instead of orphaning on the OS.
  try {
    await sessionRegistry.closeAll();
  } catch (err) {
    console.error('[server] sessionRegistry.closeAll error:', err.message);
  }

  // Close WS connections.
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server-shutdown'); } catch (_) {}
  }

  try { await prisma.$disconnect(); } catch (err) {
    console.error('[server] prisma disconnect error:', err.message);
  }

  console.log('[server] shutdown complete');
  // Give the event loop a tick to flush console output before exit.
  setTimeout(() => process.exit(0), 50);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`[server] QAAI API listening on http://localhost:${PORT}`);
  console.log(`[server] WebSocket on ws://localhost:${PORT}`);
  console.log(`[server] CORS origin: ${ORIGIN}`);
  // Reaper: tighter interval (30 s by default) so stuck-RUNNING badges
  // clear within the next refresh, not 10 minutes later when the user
  // has already lost trust in the dashboard.
  reapStaleRuns();
  reaperHandle = setInterval(reapStaleRuns, REAPER_INTERVAL_SEC * 1000);
  reaperHandle.unref();
});
