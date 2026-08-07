'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { parseWorkbook } = require('../services/testData');
const testDataApproval = require('../services/testDataApproval');
const { buildDocumentUnderstanding } = require('../services/documentUnderstanding');
const { understandWorkbook } = require('../services/testDataUnderstanding');
const { buildWorkbookContract } = require('../services/workbookContract');
const {
  buildDatasetContractV1,
  validateDatasetContractV1,
  withMappingSnapshot,
} = require('../services/datasetContractV1');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const { getProvider } = require('../lib/llmProvider');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { recordDegradation } = require('../lib/degradationSignal');
const { sanitizeWarningList, sanitizeDegradations } = require('../lib/userFacingErrors');

// Test-data ingestion is tabular: only spreadsheets and CSV/plain text yield
// real rows. Anything else (PDF/DOCX/image/binary) read by the CSV fallback
// becomes mojibake "rows". Whitelist by FORMAT (extension or mime fragment),
// never by any site-specific value (generic rule).
const TEST_DATA_EXTS = new Set(['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'txt', 'text']);
const TEST_DATA_MIME_FRAGMENTS = ['spreadsheet', 'excel', 'csv', 'text/plain', 'application/octet-stream'];

function testDataExtOf(name) {
  const s = String(name || '').toLowerCase();
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1) : '';
}

function isSupportedTestDataFormat({ name, mimeType }) {
  const ext = testDataExtOf(name);
  if (ext) {
    // A KNOWN extension is authoritative: whitelist hit → accept; otherwise
    // reject even if a generic octet-stream mime would otherwise have passed
    // (so a .pptx/.png/.docx can't slip through the mime fallback).
    return TEST_DATA_EXTS.has(ext);
  }
  const mt = String(mimeType || '').toLowerCase();
  if (!mt) return true; // no extension AND no mime → let the CSV fallback try
  return TEST_DATA_MIME_FRAGMENTS.some((frag) => mt.includes(frag));
}

// Backstop: a data URL whose decoded bytes are mostly non-printable is a binary
// file (image/PDF/DOCX) mislabeled as text — reject instead of ingesting garbage.
function testDataNonPrintableRatio(content) {
  const raw = String(content == null ? '' : content);
  let text = raw;
  if (raw.startsWith('data:')) {
    const m = raw.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/);
    if (m && /;base64/i.test(raw)) {
      try { text = Buffer.from(m[2] || '', 'base64').toString('utf8'); } catch { return 0; }
    }
  }
  const sample = text.length > 8000 ? text.slice(0, 8000) : text;
  if (!sample.length) return 0;
  let bad = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i);
    const ok = c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0x7e) || c >= 0xa0;
    if (!ok || c === 0xfffd) bad += 1;
  }
  return bad / sample.length;
}

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

const PREVIEW_ROWS = 20;
let _dataMapper = null;

function dataMapper() {
  if (_dataMapper !== null) return _dataMapper;
  try {
    _dataMapper = require('../services/agents/dataMapper');
  } catch (_) {
    _dataMapper = false;
  }
  return _dataMapper || null;
}

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

async function safeFindMany(modelName, args, fallback = []) {
  try {
    const model = prisma[modelName];
    if (!model || typeof model.findMany !== 'function') return fallback;
    return await model.findMany(args);
  } catch (_) {
    return fallback;
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function previewSheets(sheets, rowLimit = PREVIEW_ROWS) {
  return (Array.isArray(sheets) ? sheets : []).map((s) => ({
    name: s.name,
    headers: Array.isArray(s.headers) ? s.headers : [],
    rows: Array.isArray(s.rows) ? s.rows.slice(0, rowLimit) : [],
    totalRows: Array.isArray(s.rows) ? s.rows.length : 0,
  }));
}

// P4a — summary of one TestDataMapping ledger row (the immutable approved snapshot).
function serializeMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    testDataSetId: row.testDataSetId,
    version: row.version,
    status: row.status,
    approvedBy: row.approvedBy || null,
    approvedAt: row.approvedAt || null,
    approvalNote: row.approvalNote || null,
    mapping: parseJson(row.mappingJson, null),
    verification: parseJson(row.verificationJson, null),
  };
}

// P4a — draft-vs-approved state. CANONICAL key-sorted compare (not raw string) so
// key-order / whitespace never false-positives `draft_unapproved_changes`.
function computeMappingState(draftMapping, approvedRow) {
  if (!approvedRow) return draftMapping ? 'draft_unapproved_changes' : 'unmapped';
  if (!draftMapping) return 'approved';
  const approvedMapping = parseJson(approvedRow.mappingJson, null);
  return testDataApproval.canonicalJson(draftMapping) === testDataApproval.canonicalJson(approvedMapping)
    ? 'approved' : 'draft_unapproved_changes';
}

// P4a — default per-column sensitivity (the P7 export valueRef seam). UI may override.
function enrichSensitivity(mapping) {
  const bindings = (Array.isArray(mapping && mapping.bindings) ? mapping.bindings : []).map((b) => {
    const c2f = (b && b.columnToField && typeof b.columnToField === 'object') ? b.columnToField : {};
    const sensitivity = (b && b.sensitivity && typeof b.sensitivity === 'object') ? { ...b.sensitivity } : {};
    for (const role of Object.keys(c2f)) { if (!sensitivity[role]) sensitivity[role] = testDataApproval.defaultSensitivity(role); }
    return { ...b, sensitivity };
  });
  return { ...mapping, bindings };
}

function serializeTestDataSet(row, { full = false, approvedRow = null } = {}) {
  const parsed = parseJson(row.sheetsJson, { sheets: [], rowCount: row.rowCount || 0, warnings: [] });
  const mapping = parseJson(row.mappingJson, null);
  const sheets = full ? (parsed.sheets || []) : previewSheets(parsed.sheets);
  const persistedContract = parseJson(row.workbookContractJson, null);
  const datasetContract = persistedContract && persistedContract.datasetContractV1;
  return {
    id: row.id,
    projectId: row.projectId,
    sprintId: row.sprintId || null,
    name: row.name,
    rowCount: row.rowCount,
    uploadedAt: row.uploadedAt,
    sheets,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    mapping,
    mappingJson: mapping,
    testDataUnderstanding: mapping && mapping.understanding ? mapping.understanding : null,
    datasetContract: datasetContract ? {
      schemaVersion: datasetContract.schemaVersion,
      contractId: datasetContract.contractId,
      datasetRevisionId: datasetContract.datasetRevisionId,
      stats: datasetContract.stats,
      findings: datasetContract.findings,
      source: datasetContract.source,
      mappingRef: datasetContract.mappingRef,
    } : null,
    // P4a — the approval surface the friend's Approval UI consumes.
    approvedMapping: approvedRow ? serializeMapping(approvedRow) : null,
    mappingState: computeMappingState(mapping, approvedRow),
  };
}

function refreshDatasetContractMapping(row, snapshot, { strict = false } = {}) {
  const persisted = parseJson(row && row.workbookContractJson, null);
  if (!persisted || !persisted.datasetContractV1) return row && row.workbookContractJson || null;
  try {
    return JSON.stringify({
      ...persisted,
      datasetContractV1: withMappingSnapshot(persisted.datasetContractV1, snapshot),
    });
  } catch (error) {
    if (strict) throw error;
    return row && row.workbookContractJson || null;
  }
}

async function loadDocumentUnderstanding(projectId, sprintId = null) {
  const scoped = { projectId, ...(sprintId ? { sprintId } : {}) };
  const [documents, requirementClauses] = await Promise.all([
    safeFindMany('document', {
      where: scoped,
      orderBy: { uploadedAt: 'desc' },
      select: { id: true, name: true, category: true, content: true, uploadedAt: true },
    }),
    safeFindMany('requirementClause', {
      where: scoped,
      orderBy: { createdAt: 'asc' },
      select: { id: true, sourceType: true, behaviourText: true, excerpt: true, sourceDocId: true },
    }),
  ]);
  return buildDocumentUnderstanding({ documents, requirementClauses });
}

function mergeScenarioHints(documentAwareMapping, scenarioMapping) {
  if (!scenarioMapping || !Array.isArray(scenarioMapping.bindings)) return documentAwareMapping;
  const bySheet = new Map(scenarioMapping.bindings.map((b) => [String(b.sheet || '').toLowerCase(), b]));
  return {
    ...documentAwareMapping,
    bindings: (documentAwareMapping.bindings || []).map((binding) => {
      const hint = bySheet.get(String(binding.sheet || '').toLowerCase());
      if (!hint) return binding;
      return {
        ...binding,
        scenarioName: binding.scenarioName || hint.scenarioName,
        module: binding.module || hint.module,
        confidence: binding.confidence === 'low' && hint.confidence ? hint.confidence : binding.confidence,
      };
    }),
  };
}

function normaliseDocuments(body) {
  const docs = [];
  if (Array.isArray(body?.documents)) docs.push(...body.documents);
  else if (body?.document && typeof body.document === 'object') docs.push(body.document);
  else if (body?.content) docs.push(body);
  return docs.filter((d) => d && d.content);
}

function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') return false;
  if (!Array.isArray(mapping.bindings)) return false;
  if (!Array.isArray(mapping.unmapped)) return false;
  for (const b of mapping.bindings) {
    if (!b || typeof b !== 'object' || !b.sheet) return false;
    if (b.columnToField && typeof b.columnToField !== 'object') return false;
  }
  return true;
}

async function loadCurrentScenarios(projectId) {
  const generation = await prisma.scenarioGeneration.findFirst({
    where: { projectId, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { id: true },
  }).catch(() => null);
  return prisma.testScenario.findMany({
    where: generation
      ? { projectId, generationId: generation.id }
      : { projectId, generationId: null },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, module: true },
  });
}

// GET /api/projects/:projectId/test-data
router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const rows = await prisma.testDataSet.findMany({
      where: {
        projectId: project.id,
        ...(req.query.sprintId ? { sprintId: String(req.query.sprintId) } : {}),
      },
      orderBy: { uploadedAt: 'desc' },
    });
    // P4a — batch-load the latest approved mapping per set for the approval surface.
    const approvedBySet = new Map();
    try {
      const approved = await prisma.testDataMapping.findMany({
        where: { testDataSetId: { in: rows.map((r) => r.id) }, status: 'approved' },
        orderBy: { version: 'desc' },
      });
      for (const a of approved) { if (!approvedBySet.has(a.testDataSetId)) approvedBySet.set(a.testDataSetId, a); }
    } catch (_) { /* model not migrated yet → no approved mappings */ }
    res.json({ success: true, testDataSets: rows.map((r) => serializeTestDataSet(r, { approvedRow: approvedBySet.get(r.id) || null })) });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId/test-data/:tdId
router.get('/:tdId', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const row = await prisma.testDataSet.findFirst({
      where: { id: req.params.tdId, projectId: project.id },
    });
    if (!row) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    let approvedRow = null;
    try {
      approvedRow = await prisma.testDataMapping.findFirst({
        where: { testDataSetId: row.id, status: 'approved' },
        orderBy: { version: 'desc' },
      });
    } catch (_) { /* model not migrated yet */ }
    res.json({ success: true, testDataSet: serializeTestDataSet(row, { full: true, approvedRow }) });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/test-data
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const docs = normaliseDocuments(req.body || {});
    if (!docs.length) {
      return res.status(400).json({ success: false, code: 'NO_TEST_DATA', message: 'No test data file provided' });
    }

    const sprintId = req.body?.sprintId ? String(req.body.sprintId) : null;
    const documentUnderstanding = await loadDocumentUnderstanding(project.id, sprintId);
    const created = [];
    const warnings = [];
    const degradations = []; // structured honest-signal records surfaced to the UI
    let autoBindingCount = 0;
    let autoUnmappedCount = 0;

    for (const doc of docs) {
      const docName = doc.name || req.body?.name || 'test data';
      const docMime = doc.mimeType || doc.type || req.body?.mimeType;

      // ── FORMAT WHITELIST ──────────────────────────────────
      // Reject non-tabular formats up front so a PDF/DOCX/image is never read
      // by the CSV fallback into mojibake "rows".
      if (!isSupportedTestDataFormat({ name: docName, mimeType: docMime })) {
        const ext = testDataExtOf(docName) || docMime || 'unknown';
        recordDegradation({
          collector: degradations, stage: 'ingestion', severity: 'error',
          reason: `Unsupported test-data format "${ext}" for ${docName}; only spreadsheets (XLSX/XLS) and CSV/plain text yield rows`,
          impact: 'this file was rejected and contributes no test data',
        });
        warnings.push(`${docName}: unsupported format "${ext}" — provide an XLSX or CSV`);
        continue;
      }

      // ── MOJIBAKE BACKSTOP (CSV/text path only) ────────────
      // Workbook formats are binary by design and parsed by SheetJS, so skip the
      // text-shape check for them; only guard the CSV/plain-text fallback.
      const ext = testDataExtOf(docName);
      const isWorkbookFmt = ['xlsx', 'xlsm', 'xls'].includes(ext) ||
        /spreadsheet|excel/.test(String(docMime || '').toLowerCase());
      if (!isWorkbookFmt && testDataNonPrintableRatio(doc.content) > 0.30) {
        recordDegradation({
          collector: degradations, stage: 'ingestion', severity: 'error',
          reason: `Test-data file "${docName}" is not readable text (binary/mojibake detected); likely a binary file mislabeled as CSV/text`,
          impact: 'this file was rejected and contributes no test data',
        });
        warnings.push(`${docName}: content is binary/mojibake, not a readable CSV/spreadsheet`);
        continue;
      }

      const parsed = parseWorkbook({
        content: doc.content,
        name: doc.name || req.body?.name,
        mimeType: docMime,
      });
      if (parsed.warnings.length) warnings.push(...parsed.warnings.map((w) => `${doc.name || 'test data'}: ${w}`));
      const hasHeaders = parsed.sheets.some((s) => Array.isArray(s.headers) && s.headers.length);
      if (!hasHeaders) continue;

      const understood = understandWorkbook({ sheets: parsed.sheets, documentUnderstanding });
      autoBindingCount += understood.summary.bindingCount;
      autoUnmappedCount += understood.summary.unmappedCount;

      // Step 3A — stamp the canonical WorkbookContract at upload (the reproducible
      // data-oracle source). Deterministic, derived from the parsed sheets.
      const testDataSetId = randomUUID();
      let workbookContractJson = null;
      try {
        const contract = buildWorkbookContract({
          sheets: parsed.sheets,
          sourceName: doc.name || req.body?.name || 'TestData',
          generatedAt: new Date().toISOString(),
        });
        const datasetContract = buildDatasetContractV1({
          testDataSetId,
          projectId: project.id,
          sprintId,
          sourceName: doc.name || req.body?.name || 'TestData',
          sourceHash: parsed.sourceHash || null,
          parsedSheets: parsed.sheets,
          parserManifest: parsed.parserManifest || null,
          workbookContract: contract,
          mappingSnapshot: { mapping: understood.mapping, status: 'draft' },
        });
        const validation = validateDatasetContractV1(datasetContract);
        if (!validation.ok) {
          const codes = validation.errors.map((finding) => finding.code).join(', ');
          throw new Error(`dataset contract validation failed: ${codes}`);
        }
        // Keep the WorkbookContract at the root for compatibility and add the
        // immutable, value-free dataset revision contract alongside it.
        workbookContractJson = JSON.stringify({ ...contract, datasetContractV1: datasetContract });
      } catch (wbcErr) {
        warnings.push(`${doc.name || 'test data'}: workbook contract not built (${wbcErr.message})`);
        recordDegradation({
          collector: degradations,
          stage: 'dataset-contract',
          severity: 'error',
          reason: `Test-data file "${doc.name || 'test data'}" could not produce a valid immutable dataset contract: ${wbcErr.message}`,
          impact: 'this file was rejected and cannot be approved or used for generation',
        });
        continue;
      }
      const baseData = {
        id: testDataSetId,
        projectId: project.id,
        sprintId,
        name: doc.name || req.body?.name || 'TestData',
        sheetsJson: JSON.stringify({
          sheets: parsed.sheets,
          rowCount: parsed.rowCount,
          warnings: parsed.warnings,
        }),
        mappingJson: JSON.stringify(understood.mapping),
        rowCount: parsed.rowCount,
      };
      let row;
      try {
        // The immutable dataset contract is mandatory. If the deployed client/schema
        // cannot persist it, fail this upload instead of creating data that could later
        // look generation-ready without a reproducible source revision.
        row = await prisma.testDataSet.create({ data: { ...baseData, workbookContractJson } });
      } catch (error) {
        error.code = error.code || 'DATASET_CONTRACT_PERSIST_FAILED';
        throw error;
      }
      created.push(serializeTestDataSet(row));
    }

    if (!created.length) {
      const safeWarnings = sanitizeWarningList(warnings, { area: 'test-data' });
      const safeDegradations = sanitizeDegradations(degradations, { area: 'test-data' });
      return res.status(400).json({
        success: false,
        code: 'NO_USABLE_TEST_DATA',
        message: 'No usable test data sheets or headers were found.',
        warnings: safeWarnings,
        degradations: safeDegradations,
      });
    }

    const safeWarnings = sanitizeWarningList(warnings, { area: 'test-data' });
    const safeDegradations = sanitizeDegradations(degradations, { area: 'test-data' });

    await audit.log({
      userId: req.user.id,
      action: 'testData.upload',
      target: project.id,
      metadata: {
        count: created.length,
        warnings: safeWarnings.length,
        sprintId,
        autoMapped: true,
        strategy: 'pre_generation_document_aware',
        bindingCount: autoBindingCount,
        unmappedCount: autoUnmappedCount,
        degradations: safeDegradations.length,
      },
      req,
    });

    res.json({
      success: true,
      testDataSet: created[0],
      created,
      warnings: safeWarnings,
      degradations: safeDegradations,
      message: `${created.length} test data file(s) indexed and auto-mapped from document understanding.`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/test-data/:tdId/map
router.post('/:tdId/map', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const row = await prisma.testDataSet.findFirst({
      where: { id: req.params.tdId, projectId: project.id },
    });
    if (!row) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const parsed = parseJson(row.sheetsJson, { sheets: [] });
    const documentUnderstanding = await loadDocumentUnderstanding(project.id, row.sprintId || null);
    const understood = understandWorkbook({ sheets: parsed.sheets || [], documentUnderstanding });
    let mapping = understood.mapping;
    let scenarioHinted = false;
    let providerName = null;

    const mapper = dataMapper();
    if (typeof mapper?.mapTestData === 'function') {
      const scenarios = await loadCurrentScenarios(project.id);
      if (scenarios.length) {
        const creds = await resolveAiCredentials(req.user.id, project);
        providerName = creds.provider;
        const provider = creds.apiKey && creds.integration?.status === 'valid' ? getProvider(providerName) : null;
        const scenarioMapping = await mapper.mapTestData({
          sheets: parsed.sheets || [],
          scenarios,
          provider,
          apiKey: provider ? creds.apiKey : null,
          model: provider ? creds.model : null,
        });
        mapping = mergeScenarioHints(mapping, scenarioMapping);
        scenarioHinted = true;
      }
    }

    const updated = await prisma.testDataSet.update({
      where: { id: row.id },
      data: {
        mappingJson: JSON.stringify(mapping),
        workbookContractJson: refreshDatasetContractMapping(row, { mapping, status: 'draft' }),
      },
    });

    await audit.log({
      userId: req.user.id,
      action: 'testData.map',
      target: row.id,
      metadata: {
        projectId: project.id,
        bindingCount: mapping.bindings.length,
        unmappedCount: mapping.unmapped.length,
        strategy: mapping.strategy || 'pre_generation_document_aware',
        scenarioHinted,
        aiProvider: scenarioHinted ? providerName : null,
      },
      req,
    });

    res.json({ success: true, mappingJson: mapping, mapping, testDataSet: serializeTestDataSet(updated) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/projects/:projectId/test-data/:tdId/map
router.put('/:tdId/map', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const row = await prisma.testDataSet.findFirst({
      where: { id: req.params.tdId, projectId: project.id },
    });
    if (!row) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const mapping = req.body?.mappingJson || req.body?.mapping;
    if (!validateMapping(mapping)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MAPPING',
        message: 'Mapping must contain bindings[] and unmapped[].',
      });
    }

    const nextMapping = {
      ...mapping,
      version: mapping.version || 1,
      bindings: mapping.bindings,
      unmapped: mapping.unmapped,
    };
    const updated = await prisma.testDataSet.update({
      where: { id: row.id },
      data: {
        mappingJson: JSON.stringify(nextMapping),
        workbookContractJson: refreshDatasetContractMapping(row, { mapping: nextMapping, status: 'draft' }),
      },
    });

    await audit.log({
      userId: req.user.id,
      action: 'testData.mapping.update',
      target: row.id,
      metadata: { projectId: project.id, bindingCount: nextMapping.bindings.length },
      req,
    });

    res.json({ success: true, mappingJson: nextMapping, mapping: nextMapping, testDataSet: serializeTestDataSet(updated) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:projectId/test-data/:tdId
router.delete('/:tdId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const result = await prisma.testDataSet.deleteMany({
      where: { id: req.params.tdId, projectId: project.id },
    });
    await audit.log({
      userId: req.user.id,
      action: 'testData.delete',
      target: req.params.tdId,
      metadata: { projectId: project.id, deleted: result.count },
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/test-data/:tdId/approve — freeze the current draft
// mapping as a new IMMUTABLE approved version. EXISTS errors block; warning findings
// (type mismatch / unclear) require an approvalNote. Transactional + race-safe:
// max(version)+1, supersede the prior approved row, create the new one; retry on the
// @@unique([testDataSetId, version]) race (the GovernancePR max+1+retry pattern).
router.post('/:tdId/approve', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const row = await prisma.testDataSet.findFirst({ where: { id: req.params.tdId, projectId: project.id } });
    if (!row) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const persistedWorkbook = parseJson(row.workbookContractJson, null);
    const datasetContract = persistedWorkbook && persistedWorkbook.datasetContractV1;
    if (!datasetContract || !datasetContract.stats || datasetContract.stats.complete !== true) {
      return res.status(422).json({
        success: false,
        code: 'DATASET_CONTRACT_INCOMPLETE',
        findings: datasetContract && datasetContract.findings || [],
        message: 'This test-data upload is incomplete or has no immutable dataset contract. Re-upload a complete workbook before approval.',
      });
    }

    const draft = parseJson(row.mappingJson, null);
    if (!draft || !Array.isArray(draft.bindings)) {
      return res.status(400).json({ success: false, code: 'NO_MAPPING', message: 'No draft mapping to approve. Run mapping first.' });
    }
    const sheetsParsed = parseJson(row.sheetsJson, { sheets: [] });
    const verification = testDataApproval.verifyMapping({ mapping: draft, sheets: sheetsParsed.sheets || [] });
    if (!verification.ok) {
      return res.status(422).json({ success: false, code: 'MAPPING_VERIFICATION_FAILED', findings: verification.findings, message: 'Mapping references columns that are not in the sheet. Fix the draft before approving.' });
    }
    const warnings = verification.findings.filter((f) => f.severity === 'warning');
    const note = (typeof req.body?.approvalNote === 'string' && req.body.approvalNote.trim()) ? req.body.approvalNote.trim() : null;
    if (warnings.length && !note) {
      return res.status(422).json({ success: false, code: 'APPROVAL_NOTE_REQUIRED', findings: verification.findings, message: 'This mapping has warnings (type mismatch / unclear columns). Provide an approvalNote to approve over them.' });
    }

    const enriched = enrichSensitivity(draft);
    let approved = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        approved = await prisma.$transaction(async (tx) => {
          const top = await tx.testDataMapping.findFirst({ where: { testDataSetId: row.id }, orderBy: { version: 'desc' }, select: { version: true } });
          const nextVersion = (top && top.version ? top.version : 0) + 1;
          await tx.testDataMapping.updateMany({ where: { testDataSetId: row.id, status: 'approved' }, data: { status: 'superseded' } });
          const created = await tx.testDataMapping.create({
            data: {
              testDataSetId: row.id, projectId: project.id, version: nextVersion, status: 'approved',
              mappingJson: JSON.stringify({ ...enriched, version: nextVersion }),
              verificationJson: JSON.stringify(verification),
              approvalNote: note, approvedBy: req.user.id, approvedAt: new Date(),
            },
          });
          const approvedMapping = { ...enriched, version: created.version };
          await tx.testDataSet.update({
            where: { id: row.id },
            data: {
              mappingJson: JSON.stringify(approvedMapping),
              workbookContractJson: refreshDatasetContractMapping(row, {
                id: created.id,
                version: created.version,
                status: 'approved',
                mapping: approvedMapping,
              }, { strict: true }),
            },
          });
          return created;
        });
        break;
      } catch (e) {
        if (e && e.code === 'P2002' && attempt < 5) continue; // version race — retry
        throw e;
      }
    }
    await audit.log({
      userId: req.user.id, action: 'testData.mapping.approve', target: row.id,
      metadata: { projectId: project.id, version: approved.version, warnings: warnings.length, note: !!note },
      req,
    });
    res.json({ success: true, approved: serializeMapping(approved), verification });
  } catch (err) { next(err); }
});

// POST /api/projects/:projectId/test-data/:tdId/reject — record a rejected ledger
// row (audit trail). Same transactional version bump; never supersedes an approved.
router.post('/:tdId/reject', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const row = await prisma.testDataSet.findFirst({ where: { id: req.params.tdId, projectId: project.id } });
    if (!row) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const reason = (typeof req.body?.rejectedReason === 'string' && req.body.rejectedReason.trim()) ? req.body.rejectedReason.trim() : 'rejected';
    const draft = parseJson(row.mappingJson, null);

    let rejected = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        rejected = await prisma.$transaction(async (tx) => {
          const top = await tx.testDataMapping.findFirst({ where: { testDataSetId: row.id }, orderBy: { version: 'desc' }, select: { version: true } });
          const nextVersion = (top && top.version ? top.version : 0) + 1;
          return tx.testDataMapping.create({
            data: {
              testDataSetId: row.id, projectId: project.id, version: nextVersion, status: 'rejected',
              mappingJson: JSON.stringify(draft || { bindings: [], unmapped: [] }),
              rejectedReason: reason, createdBy: req.user.id,
            },
          });
        });
        break;
      } catch (e) {
        if (e && e.code === 'P2002' && attempt < 5) continue;
        throw e;
      }
    }
    await audit.log({ userId: req.user.id, action: 'testData.mapping.reject', target: row.id, metadata: { projectId: project.id, version: rejected.version, reason }, req });
    res.json({ success: true, rejected: serializeMapping(rejected) });
  } catch (err) { next(err); }
});

// GET /api/projects/:projectId/test-data/:tdId/mappings — version history (UI reads this).
router.get('/:tdId/mappings', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const row = await prisma.testDataSet.findFirst({ where: { id: req.params.tdId, projectId: project.id } });
    if (!row) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const mappings = await prisma.testDataMapping.findMany({ where: { testDataSetId: row.id }, orderBy: { version: 'desc' } }).catch(() => []);
    res.json({ success: true, mappings: mappings.map(serializeMapping) });
  } catch (err) { next(err); }
});

module.exports = router;
