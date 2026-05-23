'use strict';

/**
 * Creates real Jira / ADO work items from QAAI failure analyses.
 *
 * Looks up the user's configured Jira / ADO integration + secret in the vault
 * and POSTs against the real API. No mocks.
 */

const integrations = require('./integrations');
const vault = require('./vault');
const { normaliseUrl: jiraNormUrl } = require('./jira');
const { normaliseOrgUrl: adoNormUrl } = require('./ado');

const TIMEOUT_MS = 12_000;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, cancel: () => clearTimeout(t) };
}

// ── Jira ────────────────────────────────────────────────────
async function createJira({ userId, summary, description, projectKey }) {
  const integration = await integrations.get(userId, 'jira');
  if (!integration || integration.status !== 'valid') {
    return { ok: false, code: 'JIRA_NOT_CONFIGURED', message: 'Jira is not configured for this user.' };
  }
  const token = await vault.get(userId, 'jira.token');
  if (!token) return { ok: false, code: 'NO_TOKEN', message: 'Jira token missing in vault.' };

  const base = jiraNormUrl(integration.config.url);
  const email = integration.config.email;
  const finalProjectKey = projectKey || integration.config.projectKey;

  const body = {
    fields: {
      project: { key: finalProjectKey },
      summary: summary.slice(0, 250),
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description.slice(0, 32_000) }],
          },
        ],
      },
      issuetype: { name: 'Bug' },
    },
  };

  const { signal, cancel } = withTimeout(TIMEOUT_MS);
  try {
    const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    const resp = await fetch(`${base}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (resp.status === 401)
      return { ok: false, code: 'AUTH_FAILED', message: 'Jira rejected the email/token.' };
    if (resp.status === 403)
      return { ok: false, code: 'FORBIDDEN', message: 'Token lacks permission to create issues in this project.' };
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, code: 'UPSTREAM', message: `Jira returned ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json();
    const id = data.key || data.id;
    const url = `${base}/browse/${id}`;
    return { ok: true, id, url };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, code: 'TIMEOUT', message: 'Jira did not respond in 12s.' };
    return { ok: false, code: 'NETWORK', message: err.message };
  } finally {
    cancel();
  }
}

// ── ADO (work-item create) ──────────────────────────────────
async function createADO({ userId, summary, description, projectName }) {
  const integration = await integrations.get(userId, 'ado');
  if (!integration || integration.status !== 'valid') {
    return { ok: false, code: 'ADO_NOT_CONFIGURED', message: 'Azure DevOps is not configured for this user.' };
  }
  const pat = await vault.get(userId, 'ado.pat');
  if (!pat) return { ok: false, code: 'NO_PAT', message: 'ADO PAT missing in vault.' };

  const orgUrl = adoNormUrl(integration.config.orgUrl);
  const finalProject = projectName || integration.config.projectName;
  const url = `${orgUrl}/${encodeURIComponent(finalProject)}/_apis/wit/workitems/$Bug?api-version=7.1`;

  const ops = [
    { op: 'add', path: '/fields/System.Title', value: summary.slice(0, 250) },
    { op: 'add', path: '/fields/System.Description', value: description.slice(0, 32_000) },
  ];

  const { signal, cancel } = withTimeout(TIMEOUT_MS);
  try {
    const auth = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json-patch+json',
        Accept: 'application/json',
      },
      body: JSON.stringify(ops),
      signal,
    });
    if (resp.status === 401 || resp.status === 203)
      return { ok: false, code: 'AUTH_FAILED', message: 'ADO rejected the PAT.' };
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, code: 'UPSTREAM', message: `ADO returned ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json();
    const id = String(data.id);
    const wiUrl = `${orgUrl}/${encodeURIComponent(finalProject)}/_workitems/edit/${id}`;
    return { ok: true, id, url: wiUrl };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, code: 'TIMEOUT', message: 'ADO did not respond in 12s.' };
    return { ok: false, code: 'NETWORK', message: err.message };
  } finally {
    cancel();
  }
}

async function create({ userId, target, summary, description, projectKey, projectName }) {
  if (target === 'jira') return createJira({ userId, summary, description, projectKey });
  if (target === 'ado')  return createADO({ userId, summary, description, projectName });
  return { ok: false, code: 'INVALID_TARGET', message: 'target must be "jira" or "ado".' };
}

module.exports = { create, createJira, createADO };
