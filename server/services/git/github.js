'use strict';

/**
 * GitHub provider.
 *
 * Phase E3 — read methods: `fetchDiff({ token, repoUrl, prNumber?, branch?,
 * baseBranch? })`. Returns changed files for a PR or branch comparison.
 *
 * Phase E7 — write methods (require PAT with `repo` scope):
 *   - createBranch({ token, repoUrl, branchName, baseBranch })
 *   - commitFile({ token, repoUrl, branch, path, content, message })
 *   - openPullRequest({ token, repoUrl, head, base, title, body }) → { number, url }
 *   - pushSpec({ ... }) — convenience helper that calls all three in sequence.
 *
 * Authentication via a personal access token from the Secret vault
 * (`github.pat`). PATs need `repo` scope (or `public_repo` for public repos).
 *
 * No third-party dependency: Node's built-in `fetch` (≥ v18) is enough.
 */

const USER_AGENT = 'QAAI-Portal/0.1 (+https://github.com/qaai)';
const API_BASE = 'https://api.github.com';

/**
 * Parse `git@github.com:org/repo.git` or `https://github.com/org/repo[.git]`
 * into `{ owner, repo }`. Returns null when the URL doesn't look like a
 * GitHub repo URL.
 */
function parseRepoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // ssh: git@github.com:owner/repo.git
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // https: https://github.com/owner/repo[.git]
  const https = url.match(/^https?:\/\/(?:[^/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?(?:\?.*)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

/**
 * Extract a PR number from a PR URL ("https://github.com/org/repo/pull/123")
 * or accept a bare number. Returns null when nothing parseable was supplied.
 */
function parsePrNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function ghFetch(path, { token, method = 'GET', body, allowedStatus } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  // `allowedStatus` lets callers treat a specific non-OK status as
  // success — e.g. 422 "Reference already exists" when the branch we're
  // trying to create is already there.
  const okOverride = Array.isArray(allowedStatus) && allowedStatus.includes(res.status);
  if (!res.ok && !okOverride) {
    let bodyText = '';
    try { bodyText = (await res.text()).slice(0, 600); } catch (_) {}
    const err = new Error(`GitHub API ${res.status} ${res.statusText}: ${bodyText}`);
    err.status = res.status;
    err.code = res.status === 401 ? 'GIT_AUTH'
             : res.status === 404 ? 'GIT_NOT_FOUND'
             : res.status === 403 && /rate\s*limit/i.test(bodyText) ? 'GIT_RATE_LIMIT'
             : res.status === 403 ? 'GIT_FORBIDDEN'
             : res.status === 409 ? 'GIT_CONFLICT'
             : res.status === 422 ? 'GIT_UNPROCESSABLE'
             : 'GIT_API';
    err.providerBody = bodyText;
    throw err;
  }
  // 204 No Content / empty body fallback.
  if (res.status === 204) return null;
  try { return await res.json(); } catch (_) { return null; }
}

/**
 * Fetch the changed files for either:
 *   - a PR (when prNumber is supplied), via /repos/{o}/{r}/pulls/{n}/files
 *   - a branch comparison (when branch is supplied), via
 *     /repos/{o}/{r}/compare/{base}...{branch}
 *
 * Returns `{ changedFiles: [{path, additions, deletions, status}], ref,
 * baseRef }`. Throws on auth/repo errors.
 *
 * @param {object} opts
 * @param {string} opts.token         GitHub PAT (Secret vault).
 * @param {string} opts.repoUrl       Project.repoUrl
 * @param {string|number} [opts.prNumber]
 * @param {string} [opts.branch]
 * @param {string} [opts.baseBranch]  Defaults to 'main' for branch compare.
 */
async function fetchDiff({ token, repoUrl, prNumber, branch, baseBranch }) {
  if (!repoUrl) {
    const err = new Error('Project has no repoUrl configured.');
    err.code = 'NO_REPO_URL';
    throw err;
  }
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    const err = new Error(`Could not parse GitHub repo URL: ${repoUrl}`);
    err.code = 'INVALID_REPO_URL';
    throw err;
  }
  const { owner, repo } = parsed;
  const prNum = parsePrNumber(prNumber);

  if (prNum) {
    // Cap at 300 files — paginate if needed. Most PRs fit one page.
    const files = [];
    let page = 1;
    while (page <= 3) {
      const batch = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNum}/files?per_page=100&page=${page}`, { token });
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const f of batch) {
        files.push({
          path: f.filename,
          additions: f.additions || 0,
          deletions: f.deletions || 0,
          status: f.status || 'modified',
        });
      }
      if (batch.length < 100) break;
      page++;
    }
    // Fetch the PR metadata so we know its base/head refs for display.
    const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNum}`, { token });
    return {
      changedFiles: files,
      ref: `#${prNum}`,
      baseRef: pr?.base?.ref || 'main',
      headRef: pr?.head?.ref || null,
      title: pr?.title || null,
    };
  }

  if (branch) {
    const base = (baseBranch || 'main').trim();
    const head = String(branch).trim();
    const cmp = await ghFetch(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { token });
    const files = (cmp?.files || []).map((f) => ({
      path: f.filename,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      status: f.status || 'modified',
    }));
    return {
      changedFiles: files,
      ref: head,
      baseRef: base,
      headRef: head,
      title: null,
    };
  }

  const err = new Error('Provide either prNumber or branch.');
  err.code = 'MISSING_REF';
  throw err;
}

// ── Phase E7 — write methods ────────────────────────────────

/**
 * Resolve `{ owner, repo }` from a repoUrl, throwing a tagged error when
 * the URL doesn't parse. Used by every write method.
 */
function resolveOwnerRepo(repoUrl) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    const err = new Error(`Could not parse GitHub repo URL: ${repoUrl}`);
    err.code = 'INVALID_REPO_URL';
    err.status = 400;
    throw err;
  }
  return parsed;
}

/**
 * Create a branch off `baseBranch`. Resolves the base ref's commit SHA,
 * then creates `refs/heads/<branchName>` pointing at it.
 *
 * Returns `{ branch, baseSha, alreadyExisted }`. If the branch already
 * exists (422 "Reference already exists"), returns alreadyExisted: true
 * with the existing branch's head SHA — useful when commitFile is being
 * called against a branch from a previous failed push.
 */
async function createBranch({ token, repoUrl, branchName, baseBranch }) {
  const { owner, repo } = resolveOwnerRepo(repoUrl);
  const base = (baseBranch || 'main').trim();
  const name = String(branchName || '').trim();
  if (!name) {
    const err = new Error('branchName is required.');
    err.code = 'MISSING_BRANCH'; err.status = 400; throw err;
  }

  // Resolve base branch head SHA.
  const baseRef = await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(base)}`, { token });
  const baseSha = baseRef?.object?.sha;
  if (!baseSha) {
    const err = new Error(`Base branch "${base}" has no resolvable HEAD SHA.`);
    err.code = 'GIT_BASE_RESOLVE'; err.status = 502; throw err;
  }

  // Create new ref. 422 "Reference already exists" is non-fatal — treat
  // it as "the branch you wanted is already there, here's its head."
  const created = await ghFetch(`/repos/${owner}/${repo}/git/refs`, {
    token,
    method: 'POST',
    body: { ref: `refs/heads/${name}`, sha: baseSha },
    allowedStatus: [422],
  });
  if (created && created.ref) {
    return { branch: name, baseSha, alreadyExisted: false };
  }
  // Branch already existed — fetch its head SHA so the caller can commit
  // against the actual tip (which may have diverged from base).
  const existing = await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(name)}`, { token });
  return { branch: name, baseSha, headSha: existing?.object?.sha, alreadyExisted: true };
}

/**
 * Commit `content` to `branch` at `path` with `message`. If the file
 * already exists on that branch, the existing blob SHA is fetched and
 * passed so GitHub treats this as an update (otherwise it 422s with
 * "sha is required").
 *
 * Returns `{ path, commitSha, contentSha, branch }`.
 */
async function commitFile({ token, repoUrl, branch, path, content, message }) {
  const { owner, repo } = resolveOwnerRepo(repoUrl);
  const cleanPath = String(path || '').replace(/^\/+/, '').replace(/\.\./g, '').trim();
  if (!cleanPath) {
    const err = new Error('path is required.');
    err.code = 'MISSING_PATH'; err.status = 400; throw err;
  }
  if (typeof content !== 'string') {
    const err = new Error('content must be a string.');
    err.code = 'INVALID_CONTENT'; err.status = 400; throw err;
  }

  // Check whether the file already exists on this branch — needed for
  // the SHA when issuing the PUT-as-update.
  let existingSha = null;
  try {
    const existing = await ghFetch(
      `/repos/${owner}/${repo}/contents/${encodeURI(cleanPath)}?ref=${encodeURIComponent(branch)}`,
      { token },
    );
    if (existing && existing.sha) existingSha = existing.sha;
  } catch (err) {
    // 404 = file doesn't exist yet, expected on a fresh branch. Anything
    // else propagates.
    if (err.status !== 404) throw err;
  }

  const body = {
    message: String(message || 'QAAI: add generated test').slice(0, 400),
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  const res = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodeURI(cleanPath)}`,
    { token, method: 'PUT', body },
  );

  return {
    path: cleanPath,
    branch,
    commitSha: res?.commit?.sha || null,
    contentSha: res?.content?.sha || null,
    htmlUrl: res?.content?.html_url || null,
  };
}

/**
 * Open a pull request from `head` into `base`. Returns the PR number
 * and URL.
 */
async function openPullRequest({ token, repoUrl, head, base, title, body }) {
  const { owner, repo } = resolveOwnerRepo(repoUrl);
  if (!head || !base) {
    const err = new Error('head and base are required.');
    err.code = 'MISSING_REF'; err.status = 400; throw err;
  }
  const pr = await ghFetch(
    `/repos/${owner}/${repo}/pulls`,
    {
      token,
      method: 'POST',
      body: {
        head,
        base,
        title: String(title || 'QAAI generated test').slice(0, 256),
        body: String(body || '').slice(0, 60_000),
        maintainer_can_modify: true,
      },
    },
  );
  return {
    number: pr?.number || null,
    url: pr?.html_url || null,
    state: pr?.state || 'open',
  };
}

/**
 * Convenience: drive the whole sequence in one call. Returns the PR
 * details when successful; throws a tagged error on any failed step so
 * the route can surface the right HTTP code.
 *
 * Branch name strategy: caller passes the desired branch. We try to
 * create it; if 422 (already exists), we still commit onto it and open
 * the PR — useful when re-pushing after a transient failure mid-flow.
 *
 * @returns {Promise<{ branch, baseBranch, commitSha, prNumber, prUrl, alreadyExisted }>}
 */
async function pushSpec({ token, repoUrl, branchName, baseBranch, specPath, specContent, commitMessage, prTitle, prBody }) {
  const branchResult = await createBranch({ token, repoUrl, branchName, baseBranch });
  const commitResult = await commitFile({
    token, repoUrl,
    branch: branchResult.branch,
    path: specPath,
    content: specContent,
    message: commitMessage,
  });
  const prResult = await openPullRequest({
    token, repoUrl,
    head: branchResult.branch,
    base: (baseBranch || 'main').trim(),
    title: prTitle,
    body: prBody,
  });
  return {
    branch: branchResult.branch,
    baseBranch: (baseBranch || 'main').trim(),
    commitSha: commitResult.commitSha,
    prNumber: prResult.number,
    prUrl: prResult.url,
    alreadyExisted: branchResult.alreadyExisted,
  };
}

module.exports = {
  fetchDiff,
  parseRepoUrl,
  parsePrNumber,
  // E7 write methods
  createBranch,
  commitFile,
  openPullRequest,
  pushSpec,
};
