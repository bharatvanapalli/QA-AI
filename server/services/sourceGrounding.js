'use strict';

const crypto = require('crypto');
const { encodeJson, decodeJson } = require('./jsonField');
const featureFlags = require('./generationFeatureFlags');

const SECRET_RE = /\b(?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\b\s*[:=]\s*["']?[^"'\s,;]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function redactSourceContent(content) {
  const original = String(content || '');
  const redacted = original
    .replace(SECRET_RE, (m) => `${m.split(/[:=]/)[0]}=<redacted>`)
    .replace(EMAIL_RE, '<redacted-email>');
  return {
    content: redacted,
    redaction: {
      applied: redacted !== original,
      rules: ['secret_like_assignments', 'email_addresses'],
    },
  };
}

function splitSentences(text, limit = 80) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .slice(0, limit);
}

function extractSourceHints(content) {
  const sentences = splitSentences(content, 120);
  const requirementClauses = [];
  const businessRules = [];
  const acceptanceCriteria = [];
  const pageHints = [];
  const fieldHints = [];
  const oracleHints = [];
  const capabilitySeeds = [];
  for (const sentence of sentences) {
    if (/\b(shall|must|required|should|can|cannot|allowed|not allowed)\b/i.test(sentence)) requirementClauses.push(sentence);
    if (/\b(rule|policy|only if|unless|when|after|before|depends)\b/i.test(sentence)) businessRules.push(sentence);
    if (/\b(acceptance|expected|success|error|message|validation|display|redirect)\b/i.test(sentence)) acceptanceCriteria.push(sentence);
    if (/\b(page|screen|dashboard|form|modal|tab|menu)\b/i.test(sentence)) pageHints.push(sentence);
    if (/\b(field|input|dropdown|button|checkbox|radio|column|row)\b/i.test(sentence)) fieldHints.push(sentence);
    if (/\b(verify|assert|expect|shows|visible|hidden|toast|alert)\b/i.test(sentence)) oracleHints.push(sentence);
    if (/\b(click|select|upload|download|submit|create|edit|delete|search|filter|login|logout)\b/i.test(sentence)) capabilitySeeds.push(sentence);
  }
  return {
    requirementClauses: requirementClauses.slice(0, 60),
    businessRules: businessRules.slice(0, 40),
    acceptanceCriteria: acceptanceCriteria.slice(0, 40),
    pageHints: pageHints.slice(0, 40),
    fieldHints: fieldHints.slice(0, 40),
    oracleHints: oracleHints.slice(0, 40),
    capabilitySeeds: capabilitySeeds.slice(0, 40),
  };
}

function numberFromEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function firecrawlConfig(env = process.env) {
  const flags = featureFlags.flags();
  return {
    intakeEnabled: !!(flags.firecrawlIntakeEnabled || flags.firecrawlLiveCrawlEnabled),
    liveEnabled: !!flags.firecrawlLiveCrawlEnabled,
    apiKey: env.FIRECRAWL_API_KEY || env.QAAI_FIRECRAWL_API_KEY || '',
    apiBaseUrl: String(env.FIRECRAWL_API_URL || env.QAAI_FIRECRAWL_API_URL || 'https://api.firecrawl.dev/v2').replace(/\/+$/, ''),
    timeoutMs: numberFromEnv(env, 'QAAI_FIRECRAWL_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 }),
    requestTimeoutMs: numberFromEnv(env, 'QAAI_FIRECRAWL_REQUEST_TIMEOUT_MS', 8_000, { min: 1_000, max: 60_000 }),
    pollIntervalMs: numberFromEnv(env, 'QAAI_FIRECRAWL_POLL_INTERVAL_MS', 1_000, { min: 250, max: 10_000 }),
    maxUrls: numberFromEnv(env, 'QAAI_FIRECRAWL_MAX_URLS', 3, { min: 1, max: 20 }),
    maxPagesPerUrl: numberFromEnv(env, 'QAAI_FIRECRAWL_MAX_PAGES_PER_URL', 5, { min: 1, max: 50 }),
    maxDiscoveryDepth: numberFromEnv(env, 'QAAI_FIRECRAWL_MAX_DEPTH', 1, { min: 0, max: 4 }),
    maxContentChars: numberFromEnv(env, 'QAAI_FIRECRAWL_MAX_CONTENT_CHARS', 60_000, { min: 1_000, max: 250_000 }),
  };
}

function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '[::1]') return true;
  if (/^(0|10|127)\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function normalizeFirecrawlUrls(input, { maxUrls = 3 } = {}) {
  const raw = Array.isArray(input) ? input : (input ? [input] : []);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const candidate = typeof item === 'string'
      ? item
      : (item && (item.url || item.sourceUrl || item.href));
    if (!candidate) continue;
    let parsed;
    try { parsed = new URL(String(candidate).trim()); } catch (_) { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    if (isPrivateHostname(parsed.hostname)) continue;
    parsed.hash = '';
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxUrls) break;
  }
  return out;
}

function contentFromFirecrawlItem(item) {
  return String((item && (item.markdown || item.summary || item.html || item.rawHtml || item.text)) || '');
}

function artifactInputFromFirecrawlItem(item, fallbackUrl, { crawlDepth = null, maxContentChars = 60_000, job = null } = {}) {
  const metadata = (item && item.metadata && typeof item.metadata === 'object') ? item.metadata : {};
  const sourceUrl = metadata.sourceURL || metadata.url || item?.url || fallbackUrl || null;
  const content = contentFromFirecrawlItem(item).slice(0, maxContentChars);
  return {
    sourceUrl,
    title: metadata.title || item?.title || null,
    content,
    crawlDepth,
    robotsPolicy: 'respected',
    tenantAllowed: true,
    fetchedAt: new Date(),
    artifactJson: {
      provider: 'firecrawl',
      job,
      metadata,
      warning: item && item.warning || null,
      source: 'firecrawl',
      confidence: 'discovered',
      verifiedByPlaywright: false,
    },
  };
}

async function firecrawlRequest(path, { method = 'GET', body = null, config = firecrawlConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) throw new Error('fetch is not available for Firecrawl requests');
  if (!config.apiKey) {
    const err = new Error('FIRECRAWL_API_KEY is not configured');
    err.code = 'FIRECRAWL_API_KEY_MISSING';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const resp = await fetchImpl(`${config.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
    if (!resp.ok) {
      const err = new Error(`Firecrawl ${method} ${path} failed with ${resp.status}: ${json && (json.error || json.message) || text || resp.statusText}`);
      err.code = 'FIRECRAWL_REQUEST_FAILED';
      err.status = resp.status;
      err.response = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeFirecrawlUrl(url, { config = firecrawlConfig(), fetchImpl } = {}) {
  const json = await firecrawlRequest('/scrape', {
    method: 'POST',
    config,
    fetchImpl,
    body: {
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      removeBase64Images: true,
      blockAds: true,
      timeout: config.requestTimeoutMs,
    },
  });
  const item = json && (json.data || json);
  return item ? [artifactInputFromFirecrawlItem(item, url, { crawlDepth: 0, maxContentChars: config.maxContentChars, job: { mode: 'scrape' } })] : [];
}

async function crawlFirecrawlUrl(url, { config = firecrawlConfig(), fetchImpl, log = console } = {}) {
  const startedAt = Date.now();
  const created = await firecrawlRequest('/crawl', {
    method: 'POST',
    config,
    fetchImpl,
    body: {
      url,
      maxDiscoveryDepth: config.maxDiscoveryDepth,
      sitemap: 'include',
      ignoreQueryParameters: true,
      limit: config.maxPagesPerUrl,
      crawlEntireDomain: false,
      allowExternalLinks: false,
      allowSubdomains: false,
      ignoreRobotsTxt: false,
      maxConcurrency: 1,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        timeout: config.requestTimeoutMs,
      },
    },
  });
  const crawlId = created && created.id;
  if (!crawlId) throw new Error('Firecrawl crawl did not return a job id');

  let latest = null;
  while (Date.now() - startedAt < config.timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    latest = await firecrawlRequest(`/crawl/${encodeURIComponent(crawlId)}`, { config, fetchImpl });
    const status = String(latest && latest.status || '').toLowerCase();
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }

  if (!latest || !Array.isArray(latest.data) || !latest.data.length) {
    if (log && typeof log.info === 'function') {
      log.info(`[source-grounding] Firecrawl crawl ${crawlId} did not finish with data in ${config.timeoutMs}ms; falling back to single-page scrape.`);
    }
    return scrapeFirecrawlUrl(url, { config, fetchImpl });
  }

  return latest.data.slice(0, config.maxPagesPerUrl)
    .map((item) => artifactInputFromFirecrawlItem(item, url, {
      crawlDepth: null,
      maxContentChars: config.maxContentChars,
      job: {
        mode: 'crawl',
        id: crawlId,
        status: latest.status || null,
        total: latest.total || null,
        completed: latest.completed || null,
        creditsUsed: latest.creditsUsed || null,
      },
    }))
    .filter((item) => item.content || item.sourceUrl);
}

async function crawlFirecrawlSourceUrls({
  prisma,
  projectId,
  sprintId = null,
  generationId = null,
  urls = [],
  log = console,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = firecrawlConfig();
  if (!config.liveEnabled) return { skipped: true, reason: 'firecrawl_live_crawl_disabled', artifacts: [], errors: [] };
  if (!config.apiKey) return { skipped: true, reason: 'firecrawl_api_key_missing', artifacts: [], errors: [] };
  const safeUrls = normalizeFirecrawlUrls(urls, { maxUrls: config.maxUrls });
  if (!safeUrls.length) return { skipped: true, reason: 'no_public_firecrawl_urls', artifacts: [], errors: [] };

  const artifacts = [];
  const errors = [];
  for (const url of safeUrls) {
    try {
      let inputs;
      try {
        inputs = await crawlFirecrawlUrl(url, { config, fetchImpl, log });
      } catch (crawlErr) {
        if (log && typeof log.warn === 'function') {
          log.warn(`[source-grounding] Firecrawl crawl failed for ${url}; trying scrape fallback: ${crawlErr.message}`);
        }
        inputs = await scrapeFirecrawlUrl(url, { config, fetchImpl });
      }
      const stored = await ingestFirecrawlSourceArtifacts({
        prisma,
        projectId,
        sprintId,
        generationId,
        artifacts: inputs,
        log,
      });
      artifacts.push(...(stored.artifacts || []));
    } catch (err) {
      errors.push({ url, code: err.code || 'firecrawl_live_crawl_failed', message: err.message });
      if (log && typeof log.warn === 'function') {
        log.warn(`[source-grounding] Firecrawl live crawl failed for ${url}: ${err.message}`);
      }
    }
  }
  return { skipped: false, artifacts, errors, urls: safeUrls };
}

async function storeFirecrawlSourceArtifact({
  prisma,
  projectId,
  sprintId = null,
  generationId = null,
  sourceUrl = null,
  title = null,
  content = '',
  crawlDepth = null,
  robotsPolicy = 'unknown',
  tenantAllowed = false,
  fetchedAt = new Date(),
  expiresAt = null,
  artifactJson = null,
} = {}) {
  if (!firecrawlConfig().intakeEnabled) {
    return { skipped: true, reason: 'firecrawl_intake_disabled' };
  }
  if (!prisma) throw new Error('storeFirecrawlSourceArtifact requires prisma');
  if (!projectId) throw new Error('storeFirecrawlSourceArtifact requires projectId');
  const redacted = redactSourceContent(content);
  const hints = extractSourceHints(redacted.content);
  const contentHash = sha256(`${sourceUrl || ''}\n${redacted.content}`);
  const staleAt = expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const freshness = tenantAllowed === false || /disallow|blocked|deny/i.test(String(robotsPolicy || ''))
    ? 'unknown'
    : 'fresh';
  const payload = {
    projectId,
    sprintId,
    generationId,
    source: 'firecrawl',
    sourceArtifactVersion: 'source_artifact_v1',
    sourceUrl,
    title,
    content: redacted.content,
    artifactJson: encodeJson({
      ...(artifactJson && typeof artifactJson === 'object' ? artifactJson : {}),
      source: 'firecrawl',
      confidence: 'discovered',
      verifiedByPlaywright: false,
    }),
    requirementClausesJson: encodeJson(hints.requirementClauses),
    businessRulesJson: encodeJson(hints.businessRules),
    acceptanceCriteriaJson: encodeJson(hints.acceptanceCriteria),
    pageHintsJson: encodeJson(hints.pageHints),
    fieldHintsJson: encodeJson(hints.fieldHints),
    oracleHintsJson: encodeJson(hints.oracleHints),
    capabilitySeedsJson: encodeJson(hints.capabilitySeeds),
    confidence: 'discovered',
    verifiedByPlaywright: false,
    crawlDepth,
    fetchedAt,
    capturedAt: fetchedAt,
    expiresAt: staleAt,
    staleAt,
    robotsPolicy,
    tenantAllowed: !!tenantAllowed,
    contentHash,
    hash: contentHash,
    freshness,
    redactionJson: encodeJson(redacted.redaction),
  };
  const artifact = await prisma.sourceArtifact.create({ data: payload });
  return { skipped: false, artifact, hints };
}

async function ingestFirecrawlSourceArtifacts({
  prisma,
  projectId,
  sprintId = null,
  generationId = null,
  artifacts = [],
  log = console,
} = {}) {
  const rows = Array.isArray(artifacts) ? artifacts : [];
  if (!rows.length) return { skipped: false, artifacts: [], hints: [] };
  const stored = [];
  const hints = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const content = row.content || row.markdown || row.text || row.html || '';
    const sourceUrl = row.sourceUrl || row.url || null;
    if (!content && !sourceUrl) continue;
    try {
      const result = await storeFirecrawlSourceArtifact({
        prisma,
        projectId,
        sprintId,
        generationId,
        sourceUrl,
        title: row.title || null,
        content,
        crawlDepth: row.crawlDepth ?? row.depth ?? null,
        robotsPolicy: row.robotsPolicy || 'unknown',
        tenantAllowed: row.tenantAllowed === true,
        fetchedAt: row.fetchedAt ? new Date(row.fetchedAt) : new Date(),
        expiresAt: row.expiresAt || row.staleAt ? new Date(row.expiresAt || row.staleAt) : null,
        artifactJson: row.artifactJson || row.metadata || null,
      });
      if (result && !result.skipped && result.artifact) {
        stored.push(result.artifact);
        hints.push(result.hints || {});
      } else if (result && result.skipped && log && typeof log.info === 'function') {
        log.info(`[source-grounding] Firecrawl artifact skipped: ${result.reason}`);
      }
    } catch (err) {
      if (log && typeof log.warn === 'function') {
        log.warn(`[source-grounding] Firecrawl artifact ingestion failed: ${err.message}`);
      }
    }
  }
  return { skipped: false, artifacts: stored, hints };
}

function sourceArtifactsToRequirementClauses(artifacts = []) {
  const clauses = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!artifact || artifact.source !== 'firecrawl') continue;
    const clauseTexts = decodeJson(artifact.requirementClausesJson, []);
    if (!Array.isArray(clauseTexts) || !clauseTexts.length) continue;
    clauseTexts.forEach((text, index) => {
      clauses.push({
        id: `firecrawl:${artifact.id}:requirement:${index + 1}`,
        sourceArtifactId: artifact.id,
        source: 'firecrawl',
        sourceAuthority: 'firecrawl_discovered_source',
        confidence: 'discovered',
        verifiedByPlaywright: false,
        freshness: artifact.freshness || 'unknown',
        text,
        clause: text,
        testable: true,
      });
    });
  }
  return clauses;
}

function firecrawlEvidenceForArtifact(artifact) {
  return {
    id: artifact.id,
    sourceArtifactId: artifact.id,
    source: 'firecrawl',
    confidence: 'discovered',
    verifiedByPlaywright: false,
    freshness: artifact.freshness || 'unknown',
    sourceUrl: artifact.sourceUrl || null,
    expiresAt: artifact.expiresAt || artifact.staleAt || null,
    staleAt: artifact.staleAt || artifact.expiresAt || null,
    robotsPolicy: artifact.robotsPolicy || 'unknown',
    tenantAllowed: artifact.tenantAllowed === true,
  };
}

function attachSourceArtifactsToCases(scenarios = [], artifacts = []) {
  const byId = new Map((Array.isArray(artifacts) ? artifacts : []).filter(Boolean).map((artifact) => [String(artifact.id), artifact]));
  if (!byId.size) return scenarios;
  return (Array.isArray(scenarios) ? scenarios : []).map((scenario) => ({
    ...scenario,
    cases: (Array.isArray(scenario && scenario.cases) ? scenario.cases : []).map((testCase) => {
      const refs = [
        ...(Array.isArray(testCase.requirementRefs) ? testCase.requirementRefs : []),
        ...(Array.isArray(testCase.coverageRefs) ? testCase.coverageRefs : []),
      ];
      const evidence = [];
      for (const ref of refs) {
        const match = String(ref || '').match(/^firecrawl:([^:]+):/);
        if (!match) continue;
        const artifact = byId.get(match[1]);
        if (artifact) evidence.push(firecrawlEvidenceForArtifact(artifact));
      }
      if (!evidence.length) return testCase;
      return {
        ...testCase,
        sourceArtifacts: [
          ...(Array.isArray(testCase.sourceArtifacts) ? testCase.sourceArtifacts : []),
          ...evidence,
        ],
      };
    }),
  }));
}

async function listActiveSourceArtifacts({ prisma, projectId, generationId = null } = {}) {
  if (!prisma || !projectId) return [];
  try {
    return await prisma.sourceArtifact.findMany({
      where: {
        projectId,
        ...(generationId ? { OR: [{ generationId }, { generationId: null }] } : {}),
      },
      orderBy: [{ capturedAt: 'desc' }],
      take: 50,
    });
  } catch (_) {
    return [];
  }
}

module.exports = {
  redactSourceContent,
  extractSourceHints,
  storeFirecrawlSourceArtifact,
  ingestFirecrawlSourceArtifacts,
  crawlFirecrawlSourceUrls,
  normalizeFirecrawlUrls,
  firecrawlConfig,
  sourceArtifactsToRequirementClauses,
  attachSourceArtifactsToCases,
  listActiveSourceArtifacts,
};
