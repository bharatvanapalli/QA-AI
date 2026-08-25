'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const BRIDGE_URL = process.env.COPILOT_BRIDGE_URL || 'http://127.0.0.1:5005';

// ── GET /api/settings/copilot ──────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    let bridgeLive = false;
    try {
      const probeRes = await fetch(`${BRIDGE_URL}/health`, { method: 'GET', signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (probeRes && probeRes.ok) {
        bridgeLive = true;
      } else {
        const modelsRes = await fetch(`${BRIDGE_URL}/v1/models`, { method: 'GET', signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (modelsRes && modelsRes.ok) bridgeLive = true;
      }
    } catch (_) {}

    res.json({
      success: true,
      configured: true,
      status: 'valid',
      bridgeLive,
      bridgeUrl: BRIDGE_URL,
      model: 'copilot-gpt-4o',
      modelsAvailable: [
        { id: 'copilot-gpt-4o', label: 'GitHub Copilot (GPT-4o via VS Code)', tier: 'flagship' },
        { id: 'copilot-claude-3.5-sonnet', label: 'GitHub Copilot (Claude 3.5 Sonnet via VS Code)', tier: 'flagship' },
      ],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
