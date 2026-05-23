'use strict';

/**
 * Real Azure DevOps REST client.
 * Uses Basic auth with empty username + PAT (ADO convention).
 */

function normaliseOrgUrl(orgUrl) {
  if (!orgUrl) throw Object.assign(new Error('orgUrl required'), { code: 'INVALID_URL' });
  let u;
  try {
    u = new URL(orgUrl.trim());
  } catch {
    throw Object.assign(new Error('orgUrl is not a valid URL'), { code: 'INVALID_URL' });
  }
  if (u.protocol !== 'https:') {
    throw Object.assign(new Error('orgUrl must be https'), { code: 'INVALID_URL' });
  }
  return u.origin + u.pathname.replace(/\/$/, '');
}

function authHeader(pat) {
  return 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
}

async function adoFetch(orgUrl, path, pat, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(orgUrl + path, {
      ...init,
      headers: {
        Authorization: authHeader(pat),
        Accept: 'application/json',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

async function testConnection({ orgUrl, pat }) {
  if (!pat || typeof pat !== 'string' || pat.length < 20) {
    return { valid: false, code: 'INVALID_PAT', message: 'PAT looks malformed' };
  }
  let base;
  try {
    base = normaliseOrgUrl(orgUrl);
  } catch (e) {
    return { valid: false, code: e.code, message: e.message };
  }

  try {
    const projectsResp = await adoFetch(
      base,
      '/_apis/projects?api-version=7.1&$top=200',
      pat
    );
    if (projectsResp.status === 401 || projectsResp.status === 203) {
      // ADO returns 203 with sign-in HTML when PAT is wrong/expired
      return {
        valid: false,
        code: 'AUTH_FAILED',
        message: 'PAT rejected by Azure DevOps. Check scopes (Project & Team: Read).',
      };
    }
    if (projectsResp.status === 404) {
      return { valid: false, code: 'INVALID_URL', message: 'Organization URL not found.' };
    }
    if (!projectsResp.ok) {
      const txt = await projectsResp.text().catch(() => '');
      return {
        valid: false,
        code: 'UPSTREAM_ERROR',
        message: `ADO returned ${projectsResp.status}: ${txt.slice(0, 200)}`,
      };
    }

    const ct = projectsResp.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return {
        valid: false,
        code: 'AUTH_FAILED',
        message: 'ADO returned a sign-in page instead of JSON. PAT is likely invalid.',
      };
    }

    const data = await projectsResp.json();
    const projects = (data.value || []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || null,
      state: p.state,
    }));

    // Fetch profile separately — best effort
    let user = null;
    try {
      const meResp = await adoFetch(
        base,
        '/_apis/connectionData?api-version=7.1',
        pat
      );
      if (meResp.ok) {
        const meJson = await meResp.json();
        user = {
          displayName: meJson?.authenticatedUser?.providerDisplayName || null,
          email: meJson?.authenticatedUser?.properties?.Account?.$value || null,
          id: meJson?.authenticatedUser?.id || null,
        };
      }
    } catch (_) {}

    return { valid: true, user, projects, orgUrl: base };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: false, code: 'TIMEOUT', message: 'Azure DevOps did not respond in 12s.' };
    }
    return { valid: false, code: 'NETWORK', message: err.message };
  }
}

async function listProjects({ orgUrl, pat }) {
  const base = normaliseOrgUrl(orgUrl);
  const resp = await adoFetch(base, '/_apis/projects?api-version=7.1&$top=200', pat);
  if (!resp.ok) {
    const err = new Error(`ADO list-projects failed: ${resp.status}`);
    err.code = resp.status === 401 ? 'AUTH_FAILED' : 'UPSTREAM_ERROR';
    err.status = resp.status === 401 ? 401 : 502;
    throw err;
  }
  const data = await resp.json();
  return (data.value || []).map((p) => ({ id: p.id, name: p.name, state: p.state }));
}

/**
 * Pull work items (user stories, bugs, features) from a project.
 * Returns items with title + description for requirement ingestion.
 */
async function pullWorkItems({ orgUrl, pat, projectName, limit = 50 }) {
  const base = normaliseOrgUrl(orgUrl);
  const wiqlBody = {
    query: `SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State]
            FROM workitems
            WHERE [System.TeamProject] = '${projectName.replace(/'/g, "''")}'
              AND [System.WorkItemType] IN ('User Story', 'Feature', 'Bug')
              AND [System.State] <> 'Removed'
            ORDER BY [System.ChangedDate] DESC`,
  };

  const wiqlResp = await adoFetch(
    base,
    `/${encodeURIComponent(projectName)}/_apis/wit/wiql?api-version=7.1&$top=${limit}`,
    pat,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wiqlBody),
    }
  );
  if (!wiqlResp.ok) {
    const err = new Error('ADO WIQL failed');
    err.status = 502;
    throw err;
  }
  const wiqlData = await wiqlResp.json();
  const ids = (wiqlData.workItems || []).map((w) => w.id).slice(0, limit);
  if (!ids.length) return [];

  const detailResp = await adoFetch(
    base,
    `/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.Description,System.WorkItemType,System.State,Microsoft.VSTS.Common.AcceptanceCriteria&api-version=7.1`,
    pat
  );
  if (!detailResp.ok) return [];
  const detailData = await detailResp.json();

  return (detailData.value || []).map((w) => {
    const f = w.fields || {};
    const stripHtml = (s) =>
      typeof s === 'string' ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const content = [
      stripHtml(f['System.Description']),
      f['Microsoft.VSTS.Common.AcceptanceCriteria']
        ? 'Acceptance Criteria: ' + stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria'])
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      sourceIdentifier: String(f['System.Id']),
      title: f['System.Title'] || `Work item ${f['System.Id']}`,
      type: f['System.WorkItemType'] || 'WorkItem',
      state: f['System.State'] || null,
      content: content || f['System.Title'] || '(no body)',
    };
  });
}

module.exports = { testConnection, listProjects, pullWorkItems, normaliseOrgUrl };
