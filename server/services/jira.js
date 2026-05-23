'use strict';

/**
 * Real Jira Cloud REST client (works for Server/DC too with same endpoints).
 * Uses Basic auth with email:api-token.
 */

function normaliseUrl(url) {
  if (!url) throw Object.assign(new Error('url required'), { code: 'INVALID_URL' });
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    throw Object.assign(new Error('Jira URL is invalid'), { code: 'INVALID_URL' });
  }
  if (u.protocol !== 'https:') {
    throw Object.assign(new Error('Jira URL must be https'), { code: 'INVALID_URL' });
  }
  return u.origin;
}

function authHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function jiraFetch(base, path, email, token, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(base + path, {
      ...init,
      headers: {
        Authorization: authHeader(email, token),
        Accept: 'application/json',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function testConnection({ url, email, token }) {
  if (!email || !token) {
    return { valid: false, code: 'MISSING_FIELDS', message: 'email and token required' };
  }
  let base;
  try {
    base = normaliseUrl(url);
  } catch (e) {
    return { valid: false, code: e.code, message: e.message };
  }

  try {
    const meResp = await jiraFetch(base, '/rest/api/3/myself', email, token);
    if (meResp.status === 401) {
      return { valid: false, code: 'AUTH_FAILED', message: 'Jira rejected the email/token pair.' };
    }
    if (meResp.status === 404) {
      return { valid: false, code: 'INVALID_URL', message: 'Jira URL did not return a profile.' };
    }
    if (!meResp.ok) {
      return {
        valid: false,
        code: 'UPSTREAM_ERROR',
        message: `Jira returned ${meResp.status}`,
      };
    }
    const me = await meResp.json();

    // List projects
    const projectsResp = await jiraFetch(
      base,
      '/rest/api/3/project/search?maxResults=200',
      email,
      token
    );
    const projects = projectsResp.ok
      ? ((await projectsResp.json()).values || []).map((p) => ({
          id: p.id,
          key: p.key,
          name: p.name,
        }))
      : [];

    return {
      valid: true,
      user: {
        accountId: me.accountId,
        displayName: me.displayName,
        email: me.emailAddress || email,
      },
      projects,
      url: base,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: false, code: 'TIMEOUT', message: 'Jira did not respond in 12s.' };
    }
    return { valid: false, code: 'NETWORK', message: err.message };
  }
}

async function listProjects({ url, email, token }) {
  const base = normaliseUrl(url);
  const resp = await jiraFetch(base, '/rest/api/3/project/search?maxResults=200', email, token);
  if (!resp.ok) {
    const err = new Error('Jira list-projects failed');
    err.status = resp.status === 401 ? 401 : 502;
    err.code = resp.status === 401 ? 'AUTH_FAILED' : 'UPSTREAM_ERROR';
    throw err;
  }
  return ((await resp.json()).values || []).map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
  }));
}

/**
 * Pull issues from a Jira project for requirement ingestion.
 */
async function pullIssues({ url, email, token, projectKey, limit = 50 }) {
  const base = normaliseUrl(url);
  const jql = encodeURIComponent(
    `project = "${projectKey}" AND issuetype in (Story, Bug, Epic, Task) AND statusCategory != Done ORDER BY updated DESC`
  );
  const resp = await jiraFetch(
    base,
    `/rest/api/3/search?jql=${jql}&maxResults=${limit}&fields=summary,description,issuetype,status`,
    email,
    token
  );
  if (!resp.ok) {
    const err = new Error('Jira search failed');
    err.status = 502;
    throw err;
  }
  const data = await resp.json();

  const adfToText = (adf) => {
    if (!adf) return '';
    if (typeof adf === 'string') return adf;
    if (Array.isArray(adf)) return adf.map(adfToText).join(' ');
    if (adf.text) return adf.text;
    if (adf.content) return adfToText(adf.content);
    return '';
  };

  return (data.issues || []).map((i) => ({
    sourceIdentifier: i.key,
    title: i.fields?.summary || i.key,
    type: i.fields?.issuetype?.name || 'Issue',
    state: i.fields?.status?.name || null,
    content: adfToText(i.fields?.description).slice(0, 8000) || i.fields?.summary || '(no body)',
  }));
}

module.exports = { testConnection, listProjects, pullIssues, normaliseUrl };
