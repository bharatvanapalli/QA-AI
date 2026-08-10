import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  motion,
  AnimatePresence,
  MotionConfig,
  LayoutGroup,
  useMotionValue,
  useTransform,
  animate as animateMotion,
  useReducedMotion,
} from 'framer-motion';
import {
  Play, Check, X, Sparkles, FileText, Loader2, ChevronDown, ChevronRight,
  Plus, Minus, ThumbsUp, Zap, Target, CheckCircle2, XCircle, Circle, Clock,
  StopCircle, Search, MoreVertical, RotateCw, Trash2, ListChecks, ShieldCheck,
  BookOpen, ClipboardCheck, Wand2, Download as DownloadIcon, RefreshCcw,
  Hand, AlertTriangle, Bot, Upload, ArrowRight, ArrowLeft, MessageSquare,
  Undo2, Pencil, ArrowUp, ArrowDown, Monitor, EyeOff,
} from 'lucide-react';
import api, { ApiError, formatRunStartError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream, usePipelineState } from '../store/runStream';
import {
  PRIORITY_META, CATEGORY_META, TYPE_META, statusMeta,
} from '../lib/statusMeta';
import { estimateArchitectCost, estimateConductorRunCost, formatTokens } from '../lib/costEstimate';
import { useConfirm } from '../lib/useConfirm';
import { timeAgo } from '../lib/timeAgo';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import GenerationGuidancePanel from '../components/GenerationGuidancePanel';
import GenerationPicker from '../components/GenerationPicker';
import AuthoringAssist from '../components/testCases/AuthoringAssist';
import { ACTION_DROPDOWN_GROUPS, getActionDef } from '../lib/actionSchema';

/* ─────────────────────────────────────────────────────────────────────────────
 * Test Cases V2 — "Approve. Then run."
 *
 * Aurora Glass continues here, but the page's centre of gravity is different
 * from Overview (which surfaces a verdict) or Run Suite (which preps a brief):
 * Test Cases is a REVIEW ROOM. Big readable rows, a constantly-visible run
 * CTA on the right rail, fast filter + search keystrokes, layout-animated
 * reorder when filters apply so the user feels the list respond.
 *
 * Page story (top → bottom):
 *   1. APPROVAL HERO — readiness gauge + dominant "Run N" CTA + chip rail.
 *   2. PHASE BANNER  — when Architect/Analyst is mid-run, owned inline here.
 *   3. EXECUTION STRIP — pass/fail/blocked/skipped + approval-state pills.
 *      Each pill is a filter trigger; active pill is outlined in ink-900.
 *   4. FILTER RAIL   — Priority / Type / Confidence as glass segmented.
 *   5. SCENARIOS     — glass cards with layout-animation on filter / reorder.
 *
 * Reuses the same backend endpoints as the V1 page. No server changes.
 * ──────────────────────────────────────────────────────────────────────────── */

const SIGNAL = {
  success: '#10b981',
  danger:  '#ef4444',
  warn:    '#f59e0b',
  info:    '#3b82f6',
  accent:  '#8b5cf6',
  ink:     '#9aa3b4',
};

const HOVER_SCROLL_SUPPRESSION_MS = 420;
let hoverScrollSuppressedUntil = 0;

const VALIDATION_DETAIL_LIMIT = 6;
const VALIDATION_DETAIL_TEXT_LIMIT = 180;

function compactValidationText(value) {
  if (value == null) return '';
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= VALIDATION_DETAIL_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, VALIDATION_DETAIL_TEXT_LIMIT - 1).trimEnd()}\u2026`;
}

function structuredDeclaredAssertions(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function legacyValidationClauses(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(/(?:\r?\n|;\s*)/)
    .map(compactValidationText)
    .filter(Boolean);
}

function declaredAssertionDetail(assertion, index) {
  if (typeof assertion === 'string') return compactValidationText(assertion);
  if (!assertion || typeof assertion !== 'object') return `Validation ${index + 1}`;
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  const expected = assertion.expected && typeof assertion.expected === 'object' ? assertion.expected : {};
  const detail = assertion.description
    || assertion.statement
    || assertion.label
    || assertion.message
    || assertion.text
    || assertion.expectedText
    || expected.text
    || expected.value
    || payload.expectedText
    || payload.expectedValue
    || payload.text
    || payload.value;
  const compact = compactValidationText(detail);
  return compact || `${assertion.type || 'Validation'} ${index + 1}`;
}

export function validationSummaryForCase(tc = {}) {
  const declared = structuredDeclaredAssertions(tc.declaredAssertions);
  const clauses = legacyValidationClauses(tc.assertions);
  const numericCount = [tc.assertionCount, tc.declaredAssertionCount, tc.validationCount]
    .map((value) => Number(value))
    .find((value) => Number.isInteger(value) && value >= 0);
  const count = numericCount ?? (declared.length || clauses.length);
  const detailSource = clauses.length
    ? clauses
    : declared.map((assertion, index) => declaredAssertionDetail(assertion, index));
  const details = detailSource.slice(0, VALIDATION_DETAIL_LIMIT);
  return {
    count,
    label: `${count} validation${count === 1 ? '' : 's'}`,
    details,
    remainingCount: Math.max(0, count - details.length),
  };
}

function cleanScenarioFindingPart(value, limit = 260) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function scenarioFindingList(value, limit = 6) {
  const values = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return values.map((entry) => cleanScenarioFindingPart(entry, 100)).filter(Boolean).slice(0, limit);
}

function scenarioFindingStepSummary(step, redactText = false) {
  if (!step || typeof step !== 'object') return '';
  const action = cleanScenarioFindingPart(step.action || step.type, 60);
  const target = cleanScenarioFindingPart(step.target || step.element, 120);
  const text = redactText ? '' : cleanScenarioFindingPart(step.text, 160);
  return [action && `action=${action}`, target && `target=${target}`, text && `text=${text}`]
    .filter(Boolean)
    .join(', ');
}

function conciseScenarioFinding(finding) {
  if (finding == null) return null;
  if (typeof finding === 'string') return finding.trim() || null;
  const code = cleanScenarioFindingPart(finding.code || finding.rule || finding.kind || 'compiler_finding', 100);
  const reason = cleanScenarioFindingPart(finding.reason, 120);
  const rawDetail = finding.detail
    || finding.message
    || finding.description
    || finding.issue
    || null;
  const detail = cleanScenarioFindingPart(rawDetail, 320);
  const expectedRefs = scenarioFindingList(finding.expectedDataRefs);
  const actualRefs = scenarioFindingList(finding.actualDataRefs);
  const expected = cleanScenarioFindingPart(finding.expected, 100);
  const actualValue = finding.actual ?? finding.observed;
  const actual = cleanScenarioFindingPart(actualValue, 100);
  const comparison = expected || actual
    ? ` (expected: ${expected || 'not provided'}; observed: ${actual || 'not provided'})`
    : '';
  const stepOrdinal = Number.isFinite(Number(finding.stepOrdinal)) ? Number(finding.stepOrdinal) : null;
  const stepId = cleanScenarioFindingPart(finding.contractStepId, 100);
  const stepLabel = stepOrdinal !== null || stepId
    ? `Step ${stepOrdinal ?? '?'}${stepId ? ` (${stepId})` : ''}`
    : '';
  const sensitive = /password|passcode|secret|token|api[ _-]?key|\botp\b|\bpin\b/i.test(JSON.stringify({
    authoredTarget: finding.authoredStep?.target,
    candidateTarget: finding.candidateStep?.target,
    expectedRefs,
    actualRefs,
  }));
  const observedValues = scenarioFindingList(finding.observedValues)
    .map((value) => (sensitive ? '[redacted]' : value));
  const authored = scenarioFindingStepSummary(finding.authoredStep, sensitive);
  const candidate = scenarioFindingStepSummary(finding.candidateStep, sensitive);
  const resolution = cleanScenarioFindingPart(finding.resolutionDecision, 120);
  return [
    stepLabel,
    code,
    reason && `reason=${reason}`,
    detail && detail !== reason ? detail : '',
    expectedRefs.length ? `expected refs=[${expectedRefs.join(', ')}]` : '',
    actualRefs.length ? `actual refs=[${actualRefs.join(', ')}]` : '',
    observedValues.length ? `observed values=[${observedValues.join(', ')}]` : '',
    authored && `authored {${authored}}`,
    candidate && `candidate {${candidate}}`,
    resolution && `decision=${resolution}`,
  ].filter(Boolean).join(' | ') + comparison;
}

export function formatAddScenarioFailure(error) {
  const payload = error instanceof ApiError
    ? (error.payload || {})
    : (error?.payload && typeof error.payload === 'object' ? error.payload : {});
  let message = payload.message || error?.message || 'Scenario authoring failed.';
  try {
    const jsonStart = String(message).indexOf('{');
    if (jsonStart >= 0) {
      const parsed = JSON.parse(String(message).slice(jsonStart));
      message = parsed?.error?.message || parsed?.message || message;
    }
  } catch (_) {}

  const report = payload.report && typeof payload.report === 'object' ? payload.report : {};
  const compilerReport = report.compilerReport && typeof report.compilerReport === 'object'
    ? report.compilerReport
    : report;
  const findings = [
    ...(Array.isArray(payload.findings) ? payload.findings : []),
    ...(Array.isArray(compilerReport.findings) ? compilerReport.findings : []),
  ];
  const findingLines = findings
    .map(conciseScenarioFinding)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 8);
  const planned = Number.isFinite(Number(compilerReport.plannedCases))
    ? Number(compilerReport.plannedCases)
    : null;
  const compiled = Number.isFinite(Number(compilerReport.compiledCases))
    ? Number(compilerReport.compiledCases)
    : null;
  const reportLine = planned !== null || compiled !== null
    ? `Compiler report: ${compiled ?? '?'} of ${planned ?? '?'} planned case(s) compiled.`
    : null;
  const code = String(payload.code || error?.code || '').trim();

  return {
    title: code ? `Could not add scenario · ${code}` : 'Could not add scenario',
    message: [String(message).trim(), reportLine, ...findingLines.map((line) => `• ${line}`)]
      .filter(Boolean)
      .join('\n'),
    code: code || null,
    findings: findingLines,
  };
}

function previewObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function previewArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function previewText(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch (_) { return fallback; }
}

function previewTarget(value) {
  if (typeof value === 'string') return value;
  const target = previewObject(value) || {};
  return previewText(
    target.label || target.name || target.description || target.ref || target.role || target.kind,
    'Unspecified target',
  );
}

function orderedPreviewRecords(records, kind) {
  return previewArray(records)
    .map((record, index) => {
      const raw = previewObject(record) || { text: String(record) };
      const ordinal = Number(raw.ordinal ?? raw.order ?? raw.index);
      const hasValue = Object.prototype.hasOwnProperty.call(raw, 'value');
      const expected = Object.prototype.hasOwnProperty.call(raw, 'expected')
        ? raw.expected
        : raw.expectedValue ?? raw.expectedText ?? raw.check;
      return {
        id: raw.id || raw.key || `${kind}-${index + 1}`,
        ordinal: Number.isInteger(ordinal) && ordinal > 0 ? ordinal : index + 1,
        type: previewText(raw.type || raw.action || raw.kind, kind === 'assertion' ? 'Assert' : 'Action'),
        target: previewTarget(raw.targetIdentity || raw.target || raw.element),
        text: previewText(raw.text || raw.description || raw.statement || raw.sourceQuote),
        sourceQuote: previewText(raw.sourceQuote),
        value: hasValue ? previewText(raw.value) : '',
        valueRef: previewText(raw.valueRef || raw.dataRef),
        expected: previewText(expected),
        comparator: previewText(raw.comparator || raw.relation),
        nonBlocking: raw.nonBlocking === true || raw.required === false,
      };
    })
    .sort((left, right) => left.ordinal - right.ordinal);
}

function assertionLikePreviewRecord(record) {
  const raw = previewObject(record) || {};
  const type = previewText(raw.type || raw.action || raw.kind);
  return /^assert|^verify/i.test(type) || String(raw.kind || '').toLowerCase() === 'assertion';
}

function normalizePreviewCase(rawCase, index) {
  const source = previewObject(rawCase) || {};
  const rawSteps = previewArray(source.steps || source.operations || source.actions);
  const explicitAssertions = previewArray(source.assertions || source.declaredAssertions);
  const assertionSteps = explicitAssertions.length ? [] : rawSteps.filter(assertionLikePreviewRecord);
  const actionSteps = rawSteps.filter((record) => !assertionLikePreviewRecord(record));
  const session = previewObject(source.sessionRequirement || source.continuation || source.continuationIntent || source.session) || {};
  const mode = previewText(session.mode || source.sessionMode, 'fresh');
  const predecessorCaseId = previewText(
    session.predecessorCaseId || session.parentCaseId || source.parentCaseRef || source.dependencyOn,
  );
  return {
    id: source.id || source.key || `preview-case-${index + 1}`,
    ordinal: Number(source.ordinal) || index + 1,
    title: previewText(source.name || source.title || source.intent, `Case ${index + 1}`),
    intent: previewText(source.intent || source.description),
    initialState: previewText(source.initialState),
    expectedFinalState: previewText(source.expectedFinalState || source.finalState),
    session: {
      mode,
      predecessorCaseId,
      sameSession: session.sameSession === true || mode === 'continue_from_dependency' || mode === 'continue_from_case',
      reason: previewText(session.reason),
    },
    actions: orderedPreviewRecords(actionSteps, 'action'),
    assertions: orderedPreviewRecords([...explicitAssertions, ...assertionSteps], 'assertion'),
    dataBindings: previewArray(source.dataBindings || source.inlineLiterals).map((binding, bindingIndex) => {
      const item = previewObject(binding) || {};
      return {
        id: item.id || `binding-${bindingIndex + 1}`,
        name: previewText(item.name || item.key || item.dataRef || item.field, `Data ${bindingIndex + 1}`),
        value: Object.prototype.hasOwnProperty.call(item, 'value') ? previewText(item.value) : '',
        valueRef: previewText(item.valueRef),
        classification: previewText(item.classification, 'normal'),
      };
    }),
  };
}

function reviewableAddScenarioCode(value) {
  return /^(?:ADD_SCENARIO_(?:SEMANTIC|SOURCE)|SEMANTIC_|SOURCE_(?:LEDGER|COMPLETENESS))/i.test(String(value || ''));
}

/**
 * Defensively projects current and forthcoming Add Scenario response shapes into
 * one review-only UI model. A legacy persisted response is deliberately not
 * treated as a preview.
 */
export function normalizeAddScenarioPreviewPayload(payload, fallback = {}) {
  const root = previewObject(payload) || {};
  const explicitPreview = [
    root.preview,
    root.draft,
    root.semanticPreview,
    root.addScenarioPreview,
    root.review,
  ].map(previewObject).find(Boolean) || null;
  const explicitlyReviewOnly = root.persisted === false
    || root.previewOnly === true
    || ['preview', 'draft', 'needs_review', 'needs_clarification'].includes(String(root.status || root.mode || '').toLowerCase());
  const reviewableIssue = reviewableAddScenarioCode(root.code)
    || previewArray(root.findings).some((entry) => reviewableAddScenarioCode(entry?.code));
  if (!explicitPreview && !explicitlyReviewOnly && !reviewableIssue) return null;

  const preview = explicitPreview || root;
  const contract = [
    preview.caseContractV1,
    preview.contract,
    preview.envelope,
    preview.semanticEnvelope,
    root.caseContractV1,
    root.contract,
    root.envelope,
  ].map(previewObject).find(Boolean) || preview;
  const scenarioCases = previewArray(preview.scenarios || root.scenarios)
    .flatMap((scenario) => previewArray(previewObject(scenario)?.cases));
  const rawCases = previewArray(contract.cases || preview.cases);
  const effectiveCases = rawCases.length ? rawCases : scenarioCases;
  const sourceBlock = previewObject(preview.source || root.source) || {};
  const sourceCoverage = previewArray(
    contract.sourceCoverage || preview.sourceCoverage || root.sourceCoverage || sourceBlock.coverage,
  ).map((entry, index) => {
    const item = previewObject(entry) || {};
    return {
      id: item.id || item.sourceClauseRef || item.refId || `coverage-${index + 1}`,
      disposition: previewText(item.disposition || item.kind, 'unclassified'),
      refId: previewText(item.refId || item.recordRef),
      sourceQuote: previewText(item.sourceQuote || item.quote),
      sourceSpan: previewObject(item.sourceSpan) || null,
    };
  });
  const clarificationBlock = previewObject(preview.clarifications || root.clarifications);
  const formalClarifications = previewArray(
    contract.clarifications || preview.clarifications || preview.unresolvedQuestions || root.clarifications,
  );
  const structuredQuestions = previewArray(clarificationBlock?.questions);
  const findings = previewArray(root.findings || preview.findings || clarificationBlock?.findings);
  const clarificationError = previewObject(clarificationBlock?.error);
  const clarificationSource = formalClarifications.length
    ? formalClarifications
    : [...structuredQuestions, ...findings, ...(clarificationError ? [clarificationError] : [])];
  const clarifications = clarificationSource.map((entry, index) => {
    const item = previewObject(entry) || {};
    return {
      id: item.id || `clarification-${index + 1}`,
      question: previewText(item.question || item.message || item.detail, `Review item ${index + 1}`),
      reason: previewText(item.reason || item.code),
      blocking: item.blocking !== false,
      options: previewArray(item.options).map((option) => previewText(option)).filter(Boolean),
      sourceQuote: previewText(item.sourceQuote),
      affectedRecord: previewObject(item.affectedRecord),
    };
  });
  const completeness = previewObject(
    preview.sourceCompleteness || root.sourceCompleteness || preview.coverage || root.coverage || sourceBlock.completeness,
  ) || {};
  const totalCoverage = Number(completeness.totalUnits ?? completeness.total ?? contract.sourceClauses?.length ?? sourceCoverage.length);
  const coveredCoverage = Number(completeness.claimedUnits ?? completeness.covered ?? completeness.consumed ?? sourceCoverage.length);
  const unresolvedCoverage = Number(
    completeness.unresolved ?? completeness.unresolvedCount
      ?? sourceCoverage.filter((entry) => ['unresolved', 'clarification'].includes(entry.disposition)).length,
  );
  const approval = previewObject(preview.approval || root.approval) || {};
  const approvalLink = previewObject(
    preview.links?.approve || preview.links?.approval || root.links?.approve || root.links?.approval,
  ) || {};
  const approveEndpoint = previewText(
    approval.endpoint
      || approval.url
      || approval.href
      || preview.approvalEndpoint
      || root.approvalEndpoint
      || preview.approveEndpoint
      || root.approveEndpoint
      || approvalLink.endpoint
      || approvalLink.url
      || approvalLink.href
      || (typeof preview.links?.approve === 'string' ? preview.links.approve : '')
      || (typeof root.links?.approve === 'string' ? root.links.approve : ''),
  );
  const draftId = previewText(preview.draftId || preview.previewId || preview.id || root.draftId || root.previewId);
  const revision = previewText(preview.revision || preview.previewRevision || root.revision || root.previewRevision);
  const persistence = previewObject(preview.persistence || root.persistence) || {};
  const approvalEligible = preview.approvalEligible === true || root.approvalEligible === true;

  return {
    draftId,
    revision,
    digest: previewText(preview.digest || preview.previewDigest || preview.contractDigest || root.previewDigest),
    title: previewText(preview.title || preview.name || previewArray(preview.scenarios)[0]?.name, effectiveCases.length === 1 ? 'Scenario draft' : 'Scenario drafts'),
    persisted: Boolean(preview.persisted === true
      || root.persisted === true
      || (persistence.status && persistence.status !== 'not_persisted')),
    currentGenerationUnchanged: preview.currentGenerationUnchanged !== false
      && root.currentGenerationUnchanged !== false
      && (!persistence.status || persistence.status === 'not_persisted'),
    generationId: previewText(preview.generationId || root.generationId || persistence.currentGenerationId || fallback.generationId),
    cases: effectiveCases.map(normalizePreviewCase),
    sourceCoverage,
    coverage: {
      total: Number.isFinite(totalCoverage) ? totalCoverage : sourceCoverage.length,
      covered: Number.isFinite(coveredCoverage) ? coveredCoverage : sourceCoverage.length,
      unresolved: Number.isFinite(unresolvedCoverage) ? unresolvedCoverage : 0,
      complete: completeness.complete === true,
    },
    clarifications,
    approval: {
      endpoint: approveEndpoint,
      eligible: approvalEligible,
      enabled: Boolean(approvalEligible && approveEndpoint && draftId && revision && !clarifications.some((item) => item.blocking)),
      reason: previewText(approval.reason),
    },
    originalDesign: previewText(fallback.originalDesign),
  };
}

function flattenedPreviewOperations(preview) {
  return previewArray(preview?.cases).flatMap((testCase, caseIndex) => {
    const caseId = previewText(testCase?.id, `case-${caseIndex + 1}`);
    const project = (operation, kind, index) => {
      const operationId = previewText(operation?.id, `${kind}-${operation?.ordinal || index + 1}`);
      return {
        key: `${caseId}:${kind}:${operationId}`,
        kind,
        label: `${operation?.type || kind} on ${operation?.target || 'Unspecified target'}`,
        signature: JSON.stringify({
          type: operation?.type || '',
          target: operation?.target || '',
          text: operation?.text || '',
          value: operation?.value || '',
          valueRef: operation?.valueRef || '',
          expected: operation?.expected || '',
          comparator: operation?.comparator || '',
          nonBlocking: operation?.nonBlocking === true,
        }),
      };
    };
    return [
      ...previewArray(testCase?.actions).map((operation, index) => project(operation, 'action', index)),
      ...previewArray(testCase?.assertions).map((operation, index) => project(operation, 'assertion', index)),
    ];
  });
}

export function summarizeAddScenarioPreviewChanges(currentPreview, nextPreview) {
  const before = new Map(flattenedPreviewOperations(currentPreview).map((operation) => [operation.key, operation]));
  const after = new Map(flattenedPreviewOperations(nextPreview).map((operation) => [operation.key, operation]));
  const changed = [];
  const preserved = [];
  for (const operation of after.values()) {
    const prior = before.get(operation.key);
    if (prior && prior.signature === operation.signature) preserved.push(operation);
    else changed.push({ ...operation, disposition: prior ? 'modified' : 'added' });
  }
  for (const operation of before.values()) {
    if (!after.has(operation.key)) changed.push({ ...operation, disposition: 'removed' });
  }
  return { changed, preserved };
}

export function isValidNewerAddScenarioPreview(currentPreview, nextPreview) {
  if (!currentPreview || !nextPreview || nextPreview.persisted) return false;
  if (!currentPreview.draftId || currentPreview.draftId !== nextPreview.draftId) return false;
  if (!currentPreview.revision || !nextPreview.revision || currentPreview.revision === nextPreview.revision) return false;
  if (nextPreview.currentGenerationUnchanged !== true) return false;
  if (currentPreview.generationId && nextPreview.generationId
    && currentPreview.generationId !== nextPreview.generationId) return false;
  return previewArray(nextPreview.cases).length > 0 || previewArray(nextPreview.clarifications).length > 0;
}

export function buildAddScenarioApprovalRequest(preview, generationId = null) {
  const draftId = previewText(preview?.draftId);
  const revision = previewText(preview?.revision);
  if (!draftId || !revision) return null;
  return {
    draftId,
    revision,
    sourceDigest: previewText(preview?.digest) || null,
    generationId: previewText(generationId || preview?.generationId) || null,
  };
}

export function isAddScenarioApprovalPersistenceConfirmed(payload) {
  const root = previewObject(payload) || {};
  const persistence = previewObject(root.persistence || root.preview?.persistence) || {};
  return root.persisted === true || persistence.status === 'persisted';
}

function markHoverScrollActivity() {
  hoverScrollSuppressedUntil = Date.now() + HOVER_SCROLL_SUPPRESSION_MS;
}

function hoverSuppressedByScroll() {
  return Date.now() < hoverScrollSuppressedUntil;
}

function hoverSuppressionRemaining() {
  return Math.max(0, hoverScrollSuppressedUntil - Date.now());
}

function pointInsideRect(point, rect) {
  if (!point || !rect) return false;
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function scrollOwnerFor(node) {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !node) {
    return null;
  }
  let el = node.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    const style = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function scrollOwnerBy(owner, delta) {
  if (!owner || Math.abs(delta) <= 0.5) return;
  if (owner === document.scrollingElement || owner === document.documentElement || owner === document.body) {
    window.scrollBy(0, delta);
  } else {
    owner.scrollTop += delta;
  }
}

function preserveElementViewportPosition(anchor, duration = 140) {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    !anchor ||
    !document.documentElement.contains(anchor)
  ) {
    return false;
  }

  const owner = scrollOwnerFor(anchor);
  const targetTop = anchor.getBoundingClientRect().top;
  const stopAt = performance.now() + duration;
  let frameCount = 0;
  const tick = () => {
    if (!document.documentElement.contains(anchor)) return;
    const delta = anchor.getBoundingClientRect().top - targetTop;
    scrollOwnerBy(owner, delta);
    frameCount += 1;
    const shouldContinue =
      performance.now() < stopAt &&
      frameCount < 5 &&
      (frameCount < 2 || Math.abs(delta) > 0.8);
    if (shouldContinue) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
}

function preserveViewportDuringCollapse(collapsingNode, duration = 360) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const candidates = [
    [window.innerWidth / 2, window.innerHeight * 0.32],
    [window.innerWidth / 2, window.innerHeight * 0.48],
    [window.innerWidth / 2, window.innerHeight * 0.66],
    [window.innerWidth / 2, window.innerHeight * 0.82],
  ];
  let anchor = null;
  for (const [x, y] of candidates) {
    const candidate = document.elementFromPoint(x, y);
    if (
      candidate &&
      candidate !== document.body &&
      candidate !== document.documentElement &&
      (!collapsingNode || !collapsingNode.contains(candidate))
    ) {
      anchor = candidate;
      break;
    }
  }
  if (!anchor && collapsingNode?.nextElementSibling) {
    anchor = collapsingNode.nextElementSibling;
  }
  if (!anchor) return;
  preserveElementViewportPosition(anchor, duration);
}

function caseWasImproved(tc) {
  const guidance = String(tc?.userGuidance || '');
  return /^Scope:\s*case\b/m.test(guidance) && /(Selected directives:|User instruction:)/.test(guidance);
}

function caseImprovementFocus(tc) {
  const guidance = String(tc?.userGuidance || '');
  const explicit = guidance.match(/^Guidance focus:\s*(step|case)\b/im);
  if (explicit) return explicit[1].toLowerCase();
  if (!caseWasImproved(tc)) return null;
  return /\bstep\s*\d+\b|\bsteps?\b|\b(insert|add|remove|replace|move)\s+(a\s+|the\s+)?steps?\b|\b(assert|validate|verify|expect)\b.{0,60}\b(after|before|step\s*\d+)\b/i.test(guidance)
    ? 'step'
    : 'case';
}

function parseCaseDataBinding(tc) {
  const raw = tc?.dataBinding || tc?.dataBindingJson;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function dataBindingBadge(binding) {
  if (!binding || !binding.sheet) return null;
  const findings = Array.isArray(binding.findings) ? binding.findings : [];
  const errorCount = findings.filter((f) => f?.severity === 'error').length;
  const repairCount = findings.filter((f) => /rewritten|canonicalized|repair/i.test(String(f?.code || ''))).length;
  const complete = binding.status !== 'incomplete' && errorCount === 0;
  const label = complete ? `Data: ${binding.sheet}` : `Data incomplete: ${binding.sheet}`;
  const detail = [
    binding.rowSelector ? `Rows: ${binding.rowSelector}` : null,
    Array.isArray(binding.placeholders) && binding.placeholders.length ? `Tokens: ${binding.placeholders.join(', ')}` : null,
    repairCount ? `${repairCount} repaired` : null,
    errorCount ? `${errorCount} issue${errorCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  return {
    complete,
    label,
    detail,
    className: complete
      ? 'bg-success-50/80 text-success-700 border-success-200/70'
      : 'bg-danger-50/80 text-danger-700 border-danger-200/70',
  };
}

const TONE_TEXT = {
  success: 'text-success-700',
  danger:  'text-danger-700',
  warn:    'text-warn-700',
  info:    'text-info-700',
  accent:  'text-accent-700',
  ink:     'text-ink-600',
};

const TONE_BG = {
  success: 'bg-success-50/70 border-success-200/60',
  danger:  'bg-danger-50/70  border-danger-200/60',
  warn:    'bg-warn-50/70    border-warn-200/60',
  info:    'bg-info-50/70    border-info-200/60',
  accent:  'bg-accent-50/70  border-accent-200/60',
  ink:     'bg-ink-100/70    border-ink-200/60',
};

const PRIORITY_TONE = { P0: 'ink', P1: 'ink', P2: 'ink', P3: 'ink' };

const STATUS_DISPLAY = {
  pass:     'Passed',
  fail:     'Failed',
  blocked:  'Blocked',
  skipped:  'Skipped',
  running:  'Running',
  pending:  'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

const DEFAULT_TRIGGER_CONFIG = {
  schema: 'qaai.trigger-config/1',
  runScope: 'approved',
  runMode: 'grouped',
  execMode: 'fast',
  defaultAuthFixtureId: '',
};

function isCaseRunEligible(tc) {
  return tc?.runEligibility === 'allowed'
    || tc?.readinessStatus === 'ready'
    || tc?.compiledReadiness?.runEligibility === 'allowed'
    || tc?.compiledReadiness?.readinessStatus === 'ready';
}

function approvedAutomationCases(scenarios, { runReadyOnly = false } = {}) {
  return (scenarios || [])
    .flatMap((s) => Array.isArray(s.cases) ? s.cases : [])
    .filter((c) => c.status === 'approved' || c.status === 'running')
    .filter((c) => !runReadyOnly || isCaseRunEligible(c));
}

function readinessStatusLabel(status) {
  const key = String(status || '').toLowerCase();
  const labels = {
    needs_data_choice: 'Needs data choice',
    needs_auth_setup: 'Needs auth setup',
    needs_session_dependency: 'Needs session dependency',
    needs_oracle: 'Needs oracle',
    needs_app_clarification: 'Needs app clarification',
    repair_retry_needed: 'Repair retry needed',
    legacy_unverified: 'Legacy unverified',
    blocked: 'Blocked',
    needs_review: 'Needs review',
  };
  return labels[key] || 'Needs review';
}


// ─────────────────────────────────────────────────────────────────────────────
// AuroraSoft — quieter than Overview's; this page has dense reading content
// so the orbs sit at ~35% opacity. Three orbs covering the visible viewport.
// ─────────────────────────────────────────────────────────────────────────────
function AuroraSoft() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div
        className="aurora-orb aurora-orb-info aurora-drift-1"
        style={{ width: '44vw', height: '44vw', top: '-8vw', left: '-4vw', opacity: 0.32 }}
      />
      <div
        className="aurora-orb aurora-orb-accent aurora-drift-2"
        style={{ width: '40vw', height: '40vw', top: '0', right: '-6vw', opacity: 0.30 }}
      />
      <div
        className="aurora-orb aurora-orb-success aurora-drift-3"
        style={{ width: '36vw', height: '36vw', bottom: '-12vw', left: '28vw', opacity: 0.22 }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AnimatedNumber — counts up via framer-motion; respects prefers-reduced-motion.
// Duplicated across V2 pages so each is self-contained (no cross-page coupling).
// ─────────────────────────────────────────────────────────────────────────────
function AnimatedNumber({ value, suffix = '', duration = 0.9, decimals = 0 }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const display = useTransform(mv, (v) =>
    decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString()
  );
  useEffect(() => {
    if (reduce) { mv.set(value || 0); return; }
    const c = animateMotion(mv, value || 0, { duration, ease: [0.22, 1, 0.36, 1] });
    return c.stop;
  }, [value, duration, reduce, mv]);
  return (
    <span className="tabular-nums">
      <motion.span>{display}</motion.span>
      {suffix}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NoDocumentsState — shown when the project has no uploaded requirement documents.
// Generation is pointless without docs — direct the user back to Run Suite.
function NoDocumentsState() {
  const navigate = useNavigate();
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-2xl border border-ink-200/50"
      style={{
        background: 'rgba(250, 250, 253, 0.97)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.04)',
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: [
            'radial-gradient(ellipse 55% 45% at -5% -5%, rgba(139,92,246,0.12) 0%, transparent 55%)',
            'radial-gradient(ellipse 40% 35% at 105% 105%, rgba(59,130,246,0.08) 0%, transparent 55%)',
          ].join(', '),
        }}
        aria-hidden="true"
      />
      <div className="relative z-10 px-10 py-14 text-center max-w-lg mx-auto">
        <div
          className="w-14 h-14 rounded-2xl mx-auto mb-5 inline-flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, rgba(139,92,246,0.10), rgba(99,102,241,0.07))',
            border: '1px solid rgba(139,92,246,0.20)',
          }}
        >
          <Upload className="w-6 h-6 text-accent-500" />
        </div>
        <h3 className="font-display text-xl text-ink-900 mb-2">
          No requirement documents yet
        </h3>
        <p className="text-sm text-ink-500 leading-relaxed mb-8">
          The Architect needs your BRD, user stories, or release notes before it can propose test scenarios.
          Upload them in Run Suite, then come back here to configure and launch generation.
        </p>
        <button
          type="button"
          onClick={() => navigate('/run-suite')}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:shadow-lg hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-accent-400/40"
          style={{
            background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
            boxShadow: '0 4px 16px rgba(139,92,246,0.30)',
          }}
        >
          Go to Run Suite
          <ArrowRight className="w-4 h-4" />
        </button>
        <p className="mt-5 text-2xs text-ink-400">
          Supported formats: PDF · DOCX · MD · JSON · HTML · TXT
        </p>
      </div>
    </motion.div>
  );
}

// GenerateConfigCard — guided empty state shown when a project has no scenarios.
// Six configurable signals compiled into sessionGuidance appended to the
// architect prompt: depth, focus, exclusions, role-testing, env constraints,
// run mode. Live Prompt Signal Preview reflects the compiled state in real time.
// ─────────────────────────────────────────────────────────────────────────────
// Generation modes. `directive` is the literal instruction handed to the
// Architect (compiled into sessionGuidance); `description` is the human-facing
// tile copy. `requiresFocus` gates the Focus field; `heavy` surfaces a
// token-cost note (the Complete mode generates the most scenarios).
const DEPTH_OPTIONS = [
  {
    value: 'smoke',
    label: 'Smoke',
    description: 'Critical happy paths only. Fastest — a sanity check before a deploy.',
    directive: 'SMOKE suite — cover ONLY the critical happy paths / core flows. Keep it minimal and fast, with few negatives. This is a pre-deploy sanity pass, not full coverage.',
  },
  {
    value: 'regression',
    label: 'Regression',
    description: 'Standard coverage. Positive, negative, and key edge cases per flow.',
    directive: 'REGRESSION suite — standard balanced coverage: at least one positive, one negative, and the key edge cases for each documented flow.',
  },
  {
    value: 'functional',
    label: 'Functional',
    description: 'Does the feature work? Core flows + key negatives. Skips security, RBAC, and visual checks.',
    directive: 'FUNCTIONAL suite — verify functional correctness of the primary user flows: the happy path plus the key negative/validation cases for each. Do NOT generate security, RBAC, performance, or visual/cosmetic scenarios — keep strictly to "does the feature behave as specified".',
  },
  {
    value: 'security',
    label: 'Security',
    description: 'Auth, RBAC, injection, and authorization boundaries across every input. Minimal happy path.',
    directive: 'SECURITY suite — focus on security and authorization: authentication bypass, RBAC boundary violations, injection (SQLi / XSS), path traversal, oversized or malformed input, and session / token handling, across every user-supplied input surface in the requirements. Keep happy-path coverage minimal.',
  },
  {
    value: 'focus',
    label: 'Focus',
    description: 'Drill into ONE functionality you name below and cover it exhaustively. Everything else is skipped.',
    directive: 'FOCUS suite — generate scenarios ONLY for the functionality named in [FOCUS AREA], and cover THAT functionality exhaustively (positive, negative, edge, boundary, and security where it applies). Do NOT generate scenarios for any other module or feature.',
    requiresFocus: true,
  },
  {
    value: 'complete',
    label: 'Complete',
    description: 'Everything, end to end: every module across all test types, the maximum number of scenarios and cases.',
    directive: 'COMPLETE suite — the most exhaustive coverage possible. Cover EVERY module and feature in the requirements across ALL test types: functional, negative, edge, boundary, security / RBAC, empty-state, and integration flows. Maximize the number of distinct, non-redundant scenarios and test cases — leave no documented capability untested.',
    heavy: true,
  },
];

const ENV_CONSTRAINT_OPTIONS = [
  {
    value: 'corporate_proxy',
    label: 'Behind corporate proxy',
    tooltip: 'Network traffic routes through a corporate proxy. Scenarios requiring direct external API calls may be blocked. The Architect will flag these as known gaps rather than automatable flows.',
  },
  {
    value: 'captcha',
    label: 'CAPTCHA present',
    tooltip: 'Login or registration flows include CAPTCHA challenges. Playwright cannot solve CAPTCHAs automatically — the Architect will document these flows as manual verification steps.',
  },
  {
    value: 'demo_resets',
    label: 'Demo env resets daily',
    tooltip: 'The target environment resets its data every 24 hours. Scenarios depending on persistent state (created records, saved preferences) will be marked as environment-sensitive gaps.',
  },
  {
    value: 'file_upload',
    label: 'File upload in scope',
    tooltip: 'Test flows include file upload interactions. These are supported but require browser file-picker handling. The Architect will generate the scenarios and flag if driver access is restricted.',
  },
];

export function GenerateConfigCard({ projectId, onGenerate, generating, onCancel }) {
  // When onCancel is provided the card is being re-opened for a NEW batch on a
  // project that already has scenarios (vs. the first-run empty state). The copy
  // and a back affordance adapt; the form itself is identical.
  const isNewBatch = typeof onCancel === 'function';
  const [focus, setFocus] = useState('');
  const [depth, setDepth] = useState('regression');
  const [exclusions, setExclusions] = useState('');
  const [testAllRoles, setTestAllRoles] = useState(true);
  const [negativeRbac, setNegativeRbac] = useState(true);
  const [envConstraints, setEnvConstraints] = useState(new Set());
  const [modulePreview, setModulePreview] = useState(null);
  const [moduleLoading, setModuleLoading] = useState(false);
  const [moduleError, setModuleError] = useState(null);
  const [selectedModuleKey, setSelectedModuleKey] = useState('');
  // Explicit atlas rebuild. OFF by default: the backend reuses a recent matching
  // atlas and only re-crawls when there's a concrete reason (target/auth change,
  // a deeper mode than the existing atlas, or staleness). Turning this ON forces
  // a fresh crawl regardless — the "I want to re-map the site now" escape hatch.
  const [rebuildAtlas, setRebuildAtlas] = useState(false);

  const depthMeta = DEPTH_OPTIONS.find((d) => d.value === depth);
  const detectedModules = modulePreview?.preview?.modules || [];
  const selectedModule = detectedModules.find((m) => m.key === selectedModuleKey) || null;
  const focusRequired = !!depthMeta?.requiresFocus;
  const focusMissing = focusRequired && !focus.trim() && !selectedModule;

  useEffect(() => {
    if (!projectId) {
      setModulePreview(null);
      setSelectedModuleKey('');
      return undefined;
    }
    let cancelled = false;
    setModuleLoading(true);
    setModuleError(null);
    api.safe.get(`/projects/${projectId}/modules/preview`)
      .then(({ ok, data, error }) => {
        if (cancelled) return;
        if (!ok) {
          setModulePreview(null);
          setModuleError(error?.toUserMessage?.() || error?.message || 'Could not load modules.');
          return;
        }
        setModulePreview(data || null);
      })
      .finally(() => {
        if (!cancelled) setModuleLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!selectedModuleKey) return;
    if (!detectedModules.some((m) => m.key === selectedModuleKey)) setSelectedModuleKey('');
  }, [detectedModules, selectedModuleKey]);

  const toggleConstraint = (val) => {
    setEnvConstraints((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val); else next.add(val);
      return next;
    });
  };

  const previewRows = useMemo(() => {
    const roleLabel = testAllRoles
      ? (negativeRbac ? 'All roles + neg. RBAC' : 'All roles')
      : 'Primary role only';
    const envLabel = envConstraints.size === 0
      ? 'None'
      : [...envConstraints]
          .map((c) => ENV_CONSTRAINT_OPTIONS.find((e) => e.value === c)?.label ?? c)
          .join(', ');
    const focusLabel = focus.trim() || 'None — Architect decides';
    const skipLabel = exclusions.trim() || 'None';
    return [
      { label: 'Mode',           value: depthMeta?.label ?? depth,  dot: 'green' },
      { label: 'Module',         value: selectedModule ? selectedModule.name : 'All modules', dot: selectedModule ? 'green' : 'grey' },
      { label: 'Roles',          value: roleLabel,                  dot: testAllRoles ? 'green' : 'amber' },
      { label: 'Environment',    value: envLabel,                   dot: envConstraints.size > 0 ? 'green' : 'grey' },
      { label: 'Critical flows', value: focusLabel,                 dot: focus.trim() ? 'green' : 'amber' },
      { label: 'Skip',           value: skipLabel,                  dot: exclusions.trim() ? 'green' : 'grey' },
    ];
  }, [depth, testAllRoles, negativeRbac, envConstraints, focus, exclusions, selectedModule]);

  const handleSubmit = () => {
    if (focusMissing || generating) return;
    const parts = [];
    if (depthMeta) {
      parts.push(`[GENERATION MODE — ${depthMeta.label}]: ${depthMeta.directive}`);
    }
    if (selectedModule) {
      parts.push(`[MODULE SCOPE]: Generate ONLY the "${selectedModule.name}" module (module key: ${selectedModule.key}). Treat shared authentication/setup data as support for this module, not as a separate suite.`);
    }
    if (focus.trim()) {
      parts.push(`[FOCUS AREA]: Prioritize these flows above all others: ${focus.trim()}`);
    }
    if (exclusions.trim()) {
      parts.push(`[EXCLUSIONS]: Explicitly skip these modules or features — do not generate scenarios for them: ${exclusions.trim()}`);
    }
    if (testAllRoles) {
      const rbacSuffix = negativeRbac
        ? ' Include negative RBAC tests that verify restricted roles cannot access admin-only pages via direct URL navigation.'
        : '';
      parts.push(`[ROLE TESTING]: Generate boundary scenarios for every role defined in the source documents.${rbacSuffix}`);
    } else {
      parts.push(`[ROLE TESTING]: Focus on the primary user role only. Do not generate RBAC or role-switching scenarios.`);
    }
    const activeConstraints = [...envConstraints];
    if (activeConstraints.length > 0) {
      const lines = activeConstraints
        .map((c) => ENV_CONSTRAINT_OPTIONS.find((e) => e.value === c)?.label)
        .filter(Boolean)
        .map((label) => `- ${label}: document affected scenarios as known gaps rather than automatable flows`);
      parts.push(
        `[ENVIRONMENT CONSTRAINTS]: The following environment limitations apply. Do NOT generate scenarios that would fail for infrastructure reasons — document them as known gaps instead:\n${lines.join('\n')}`,
      );
    }
    onGenerate(parts.join('\n\n') || null, {
      // Structured generation mode (smoke|regression|functional|security|focus|
      // complete) so the backend's crawl-depth decision never depends on parsing a
      // prose label out of sessionGuidance (brittle if the label copy changes).
      generationMode: depth,
      ...(selectedModule ? { module: selectedModule.key, moduleName: selectedModule.name } : {}),
      // Focus mode: pass the focus area so the backend scopes the clause set + RTM
      // denominator to the focused functionality (not the whole BRD), even when no
      // explicit module is selected. Gated to Focus mode where the field is shown.
      ...(focusRequired && focus.trim() ? { focusArea: focus.trim() } : {}),
      // Only force a re-crawl when the user explicitly asked; otherwise the backend
      // reuses a recent matching atlas (no more unconditional recrawl on every run).
      ...(rebuildAtlas ? { forceAtlasRefresh: true } : {}),
    });
  };

  const DOT_COLOR = { green: '#10b981', amber: '#f59e0b', grey: '#94a3b8' };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-2xl border border-accent-200/50"
      style={{
        background: 'rgba(250, 248, 255, 0.97)',
        boxShadow: '0 0 0 1px rgba(139,92,246,0.08), 0 8px 40px rgba(139,92,246,0.10), 0 2px 8px rgba(0,0,0,0.04)',
      }}
    >
      {/* Aurora atmosphere — stronger opacity so it actually shows */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: [
            'radial-gradient(ellipse 65% 55% at -8% -8%, rgba(139,92,246,0.28) 0%, transparent 58%)',
            'radial-gradient(ellipse 50% 45% at 108% 108%, rgba(59,130,246,0.20) 0%, transparent 55%)',
            'radial-gradient(ellipse 45% 35% at 108% -5%, rgba(99,102,241,0.16) 0%, transparent 52%)',
            'radial-gradient(ellipse 35% 30% at 50% 108%, rgba(16,185,129,0.10) 0%, transparent 55%)',
          ].join(', '),
        }}
        aria-hidden="true"
      />
      {/* Subtle noise texture for depth */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.025]"
        style={{
          backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\'/%3E%3C/svg%3E")',
          backgroundSize: '256px 256px',
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 p-8 md:p-12">
        {/* Back to current scenarios — only when re-opened for a new batch */}
        {isNewBatch && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 mb-5 px-2.5 h-8 rounded-pill text-xs font-semibold bg-white/60 border border-ink-200/70 text-ink-600 hover:bg-white hover:text-accent-700 hover:border-accent-300 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to current scenarios
          </button>
        )}
        {/* ── Header ── */}
        <div className="flex items-center gap-2.5 mb-3">
          <div
            className="w-8 h-8 rounded-xl inline-flex items-center justify-center flex-shrink-0"
            style={{
              background: 'linear-gradient(135deg, rgba(139,92,246,0.18), rgba(99,102,241,0.12))',
              border: '1px solid rgba(139,92,246,0.30)',
              boxShadow: '0 2px 8px rgba(139,92,246,0.15)',
            }}
          >
            <Sparkles className="w-4 h-4 text-accent-600" />
          </div>
          <span className="text-2xs uppercase tracking-[0.22em] font-bold text-accent-600">
            {isNewBatch ? 'New scenario batch' : 'Configure test suite'}
          </span>
        </div>
        <h2 className="font-display text-2xl md:text-3xl text-ink-900 tracking-tight mb-2">
          {isNewBatch ? 'Generate a new batch' : 'What should the Architect focus on?'}
        </h2>
        <p className="text-sm text-ink-500 mb-10 leading-relaxed">
          {isNewBatch
            ? 'Pick a different mode or focus area. Your current scenarios are kept under the version selector in the header — this creates a new generation you can switch between anytime.'
            : "Answer these questions. The AI reads your uploaded requirements and builds scenarios that match your priorities — skipping what you don't need."}
        </p>

        {/* ── All sections full-width ── */}
        <div className="space-y-9">

          {/* Generation mode — 6 tiles, 2–3 across */}
          <div>
            <p className="text-xs font-semibold text-ink-600 uppercase tracking-[0.14em] mb-4">
              What kind of suite should the Architect generate?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {DEPTH_OPTIONS.map((opt) => {
                const sel = depth === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDepth(opt.value)}
                    className={`relative text-left px-5 py-4 rounded-2xl border transition-all duration-200 overflow-hidden ${
                      sel
                        ? 'border-accent-400/80 shadow-lg'
                        : 'border-ink-200/70 hover:border-accent-300/60 hover:shadow-md'
                    }`}
                    style={sel ? {
                      background: 'linear-gradient(135deg, rgba(139,92,246,0.10) 0%, rgba(99,102,241,0.06) 100%)',
                      boxShadow: '0 4px 20px rgba(139,92,246,0.14)',
                    } : {
                      background: 'rgba(255,255,255,0.55)',
                    }}
                  >
                    {sel && (
                      <span
                        className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full"
                        style={{ background: 'linear-gradient(180deg,#8b5cf6,#6366f1)' }}
                      />
                    )}
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-sm font-bold ${sel ? 'text-accent-700' : 'text-ink-800'}`}>
                        {opt.label}
                      </span>
                      {opt.heavy && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-pill text-2xs font-bold uppercase tracking-wide bg-warn-50 text-warn-700 border border-warn-200/70">
                          <Zap className="w-2.5 h-2.5" /> Heavy
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-500 leading-relaxed">{opt.description}</div>
                  </button>
                );
              })}
            </div>
            {depth === 'complete' && (
              <div className="mt-3 flex items-start gap-2 px-4 py-3 rounded-xl border border-warn-200/70 bg-warn-50/50 text-xs text-warn-800 leading-relaxed">
                <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  <strong>Complete</strong> generates the most scenarios and test cases across every module — expect it to use
                  somewhat more tokens and take a little longer than the other modes.
                </span>
              </div>
            )}
          </div>

          {/* Critical flows + Skip list — side by side */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-4">
              <p className="text-xs font-semibold text-ink-600 uppercase tracking-[0.14em]">
                Module scope
              </p>
              {moduleLoading && (
                <span className="inline-flex items-center gap-1.5 text-2xs font-semibold text-ink-500">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Reading documents
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setSelectedModuleKey('')}
                className={`text-left px-5 py-4 rounded-2xl border transition-all duration-150 ${
                  !selectedModule
                    ? 'border-accent-400/80 bg-white/70 shadow-md'
                    : 'border-ink-200/70 bg-white/45 hover:bg-white/70 hover:border-accent-300/60'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Target className={`w-4 h-4 ${!selectedModule ? 'text-accent-600' : 'text-ink-400'}`} />
                  <span className={`text-sm font-bold ${!selectedModule ? 'text-accent-700' : 'text-ink-800'}`}>
                    All modules
                  </span>
                </div>
                <div className="text-xs text-ink-500 leading-relaxed">
                  {modulePreview?.preview?.totals?.moduleCount
                    ? `${modulePreview.preview.totals.moduleCount} detected module${modulePreview.preview.totals.moduleCount === 1 ? '' : 's'} stay in scope.`
                    : 'Use the complete project context.'}
                </div>
              </button>

              {detectedModules.map((mod) => {
                const selected = selectedModuleKey === mod.key;
                return (
                  <button
                    key={mod.key}
                    type="button"
                    onClick={() => setSelectedModuleKey(mod.key)}
                    className={`text-left px-5 py-4 rounded-2xl border transition-all duration-150 ${
                      selected
                        ? 'border-accent-400/80 bg-white/75 shadow-md'
                        : 'border-ink-200/70 bg-white/45 hover:bg-white/70 hover:border-accent-300/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className={`text-sm font-bold truncate ${selected ? 'text-accent-700' : 'text-ink-800'}`} title={mod.name}>
                        {mod.name}
                      </span>
                      <span className="shrink-0 text-2xs font-bold text-ink-500 tabular-nums">
                        {Math.round((mod.confidence || 0) * 100)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 text-[11px] text-ink-500 tabular-nums">
                      <span>{mod.requirements?.count || 0} reqs</span>
                      <span>{mod.testData?.sheetCount || 0} sheets</span>
                      <span>{mod.atlas?.currentSliceCount || 0} atlas</span>
                    </div>
                  </button>
                );
              })}
            </div>
            {moduleError && (
              <div className="mt-3 flex items-start gap-2 px-4 py-3 rounded-xl border border-warn-200/70 bg-warn-50/50 text-xs text-warn-800 leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{moduleError}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-semibold text-ink-600 uppercase tracking-[0.14em] mb-2">
                {focusRequired ? 'Which functionality should this batch cover?' : 'What are the most critical user flows?'}{' '}
                {focusRequired ? (
                  <span className="font-bold normal-case tracking-normal text-warn-600">(required for Focus mode)</span>
                ) : (
                  <span className="font-normal normal-case tracking-normal text-ink-400">(optional)</span>
                )}
              </p>
              <textarea
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                rows={3}
                placeholder="e.g. Login with invalid credentials. RBAC boundary — ESS user cannot access Admin module. Guest checkout without saving card details."
                className={`w-full px-4 py-3 text-sm rounded-xl border bg-white/60 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-400/40 focus:border-accent-400 resize-none transition-colors leading-relaxed ${
                  focusMissing ? 'border-warn-300' : 'border-ink-200/70'
                }`}
              />
              <p className="mt-1.5 text-2xs text-ink-400 leading-relaxed">
                {focusRequired
                  ? 'Focus mode covers ONLY this functionality, exhaustively — name the module or feature (e.g. "Order creation & approval"). Everything else is skipped.'
                  : 'Named flows are prioritised as P0 scenarios. Leave empty and the Architect balances coverage across all features.'}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-ink-600 uppercase tracking-[0.14em] mb-2">
                Any modules or features to skip?{' '}
                <span className="font-normal normal-case tracking-normal text-ink-400">(optional)</span>
              </p>
              <textarea
                value={exclusions}
                onChange={(e) => setExclusions(e.target.value)}
                rows={3}
                placeholder="e.g. Orders module. Account settings. Any scenario requiring file upload."
                className="w-full px-4 py-3 text-sm rounded-xl border border-ink-200/70 bg-white/60 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-400/40 focus:border-accent-400 resize-none transition-colors leading-relaxed"
              />
              <p className="mt-1.5 text-2xs text-ink-400 leading-relaxed">
                Skipped modules are excluded entirely — the Architect won't generate or reference them.
              </p>
            </div>
          </div>

          {/* Role testing — 2 toggles side by side */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <p className="text-xs font-semibold text-ink-600 uppercase tracking-[0.14em]">
                Which roles should be tested?
              </p>
              <span className="px-1.5 py-px text-2xs font-bold rounded bg-accent-100 text-accent-700 border border-accent-200/60 uppercase tracking-wide">
                new
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[
                {
                  key: 'testAllRoles',
                  checked: testAllRoles,
                  onChange: setTestAllRoles,
                  label: 'Test all roles from source documents',
                  sub: 'Generates RBAC boundary scenarios for every role defined in the BRD or User Stories.',
                  disabled: false,
                },
                {
                  key: 'negativeRbac',
                  checked: negativeRbac,
                  onChange: setNegativeRbac,
                  label: 'Include negative RBAC tests',
                  sub: 'Verifies restricted roles cannot access admin-only pages via direct URL navigation.',
                  disabled: !testAllRoles,
                },
              ].map(({ key, checked, onChange, label, sub, disabled }) => (
                <div
                  key={key}
                  className={`flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border transition-all duration-150 ${
                    disabled
                      ? 'border-ink-100/60 bg-white/15 opacity-45 pointer-events-none'
                      : 'border-ink-200/60 bg-white/45'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink-800 leading-snug">{label}</div>
                    <div className="text-xs text-ink-500 mt-0.5 leading-relaxed">{sub}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={checked}
                    onClick={() => onChange(!checked)}
                    className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-400/40 ${
                      checked ? 'bg-accent-500' : 'bg-ink-300/70'
                    }`}
                  >
                    <span
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
                        checked ? 'left-[26px]' : 'left-1'
                      }`}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Site atlas — explicit force re-crawl (default reuse) */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <p className="text-xs font-semibold text-ink-600 uppercase tracking-[0.14em]">Site atlas</p>
            </div>
            <div className="flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border border-ink-200/60 bg-white/45">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink-800 leading-snug">Rebuild site atlas (force re-crawl)</div>
                <div className="text-xs text-ink-500 mt-0.5 leading-relaxed">Off by default — a recent matching crawl is reused. Turn on to re-map the site now. The crawl auto-refreshes anyway when the target URL, login identity, or generation depth changes.</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={rebuildAtlas}
                onClick={() => setRebuildAtlas(!rebuildAtlas)}
                className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-400/40 ${rebuildAtlas ? 'bg-accent-500' : 'bg-ink-300/70'}`}
              >
                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200 ${rebuildAtlas ? 'left-[26px]' : 'left-1'}`} />
              </button>
            </div>
          </div>

          {/* Environment constraints — 4 pills full width with hover tooltips */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <p className="text-xs font-semibold text-ink-600 uppercase tracking-[0.14em]">
                Environment constraints
              </p>
              <span className="px-1.5 py-px text-2xs font-bold rounded bg-accent-100 text-accent-700 border border-accent-200/60 uppercase tracking-wide">
                new
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {ENV_CONSTRAINT_OPTIONS.map((opt) => {
                const active = envConstraints.has(opt.value);
                return (
                  <div key={opt.value} className="group relative">
                    <button
                      type="button"
                      onClick={() => toggleConstraint(opt.value)}
                      className={`w-full text-center px-4 py-3.5 rounded-xl border text-sm font-medium transition-all duration-150 ${
                        active
                          ? 'border-accent-400/70 text-accent-700 shadow-md'
                          : 'border-ink-200/70 bg-white/50 text-ink-700 hover:border-accent-300/60 hover:bg-white/70 hover:shadow-sm'
                      }`}
                      style={active ? {
                        background: 'linear-gradient(135deg, rgba(139,92,246,0.10), rgba(99,102,241,0.06))',
                      } : {}}
                    >
                      {opt.label}
                    </button>
                    {/* Hover tooltip */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 w-60 p-3 rounded-xl text-2xs text-white/90 leading-relaxed opacity-0 group-hover:opacity-100 transition-all duration-150 pointer-events-none z-40 shadow-2xl"
                      style={{ background: 'rgba(15,14,23,0.96)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      {opt.tooltip}
                      <div
                        className="absolute top-full left-1/2 -translate-x-1/2"
                        style={{
                          width: 0, height: 0,
                          borderLeft: '6px solid transparent',
                          borderRight: '6px solid transparent',
                          borderTop: '6px solid rgba(15,14,23,0.96)',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-2xs text-ink-400 leading-relaxed">
              Selected constraints suppress scenarios that would fail for infrastructure reasons — the Architect documents them as known gaps instead.
            </p>
          </div>

          {/* Prompt signal preview — horizontal strip */}
          <div
            className="rounded-2xl border border-ink-200/60 overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.55)', backdropFilter: 'blur(8px)' }}
          >
            <div className="px-5 py-3 border-b border-ink-100/70 flex items-center justify-between">
              <span className="text-2xs font-bold text-ink-600 uppercase tracking-[0.16em]">
                Prompt signal preview
              </span>
              <span className="text-2xs text-ink-400">What the Architect reads before processing your requirements</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-ink-100/70">
              {previewRows.map(({ label, value, dot }) => (
                <div key={label} className="px-4 py-4">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span
                      className="flex-shrink-0 w-2 h-2 rounded-full"
                      style={{ backgroundColor: DOT_COLOR[dot] }}
                    />
                    <span className="text-2xs font-bold text-ink-500 uppercase tracking-[0.10em]">{label}</span>
                  </div>
                  <div className="text-xs text-ink-800 font-medium leading-snug break-words">{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="pt-1">
            <div className="flex items-center gap-3">
              {isNewBatch && (
                <Button
                  size="md"
                  variant="ghost"
                  onClick={onCancel}
                  disabled={generating}
                  className="justify-center"
                >
                  Cancel
                </Button>
              )}
              <Button
                size="md"
                tone="accent"
                onClick={handleSubmit}
                loading={generating}
                disabled={generating || focusMissing}
                className="flex-1 justify-center"
                title={focusMissing ? 'Name the functionality to focus on first' : undefined}
              >
                <Sparkles className="w-4 h-4" />
                {isNewBatch ? 'Generate new batch' : 'Generate scenarios'}
              </Button>
            </div>
            {focusMissing && (
              <p className="mt-2 text-2xs text-warn-600 font-medium">
                Focus mode needs a functionality named above before it can generate.
              </p>
            )}
          </div>

        </div>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ApprovalHero — the centrepiece. Left: radial gauge showing % approved.
// Right: big italic headline ("Review.", "Ready.", "Awaiting evidence.") +
// supporting copy + Run CTA + secondary action chips.
// ─────────────────────────────────────────────────────────────────────────────
function ApprovalHero({
  counts, runCostEstimate, executing, canRun, generating, architectProgress,
  running, selecting, approving, hasImpacted, impactedPendingCount, hasRuns,
  scenarioOperation,
  onGenerate, onSmartSelect, onApproveAll,
  onApproveImpacted, onExecute,
}) {
  // Approval percent — % of total cases approved. Drives the gauge.
  const approvalPct = counts.total > 0
    ? Math.round((counts.approved / counts.total) * 100)
    : 0;

  // When the Architect is streaming, the ACTUAL scenario count is unknown
  // until the stream completes — the prompt caps automation at 12 but
  // manual stories stack on top, so any fixed "of N" denominator lies. We
  // drop the percent entirely and show the live scenario count instead.
  // The ring still fills visually as a progress cue (each scenario nudges
  // it forward, capped at 90%) but no number is displayed AS a percent.
  const scenariosSoFar = architectProgress?.scenariosSoFar || 0;
  const generationRingFill = Math.min(15 + scenariosSoFar * 7, 90);

  // Hero verdict word — adapts to current state. When regenerating, the OLD
  // counts are still in the DB (the wipe happens at the end of the route),
  // so the existing "29 ready" headline would mislead the user. Swap copy
  // to make it explicit that the current cases are about to be replaced.
  let headline, supportingCopy, tone;
  if (scenarioOperation?.status === 'running') {
    tone = 'accent';
    headline = scenarioOperation.type === 'refine' ? 'Refining scenario.' : 'Regenerating scenario.';
    supportingCopy = `${scenarioOperation.scenarioLabel ? `${scenarioOperation.scenarioLabel} · ` : ''}${scenarioOperation.scenarioName || 'Selected scenario'} is being updated with ${scenarioOperation.caseCount || 0} test case${scenarioOperation.caseCount === 1 ? '' : 's'}. This is targeted authoring work, not a live browser run.`;
  } else if (generating) {
    tone = 'accent';
    if (counts.total > 0) {
      headline = 'Regenerating…';
      supportingCopy = `Building a fresh generation from your requirements. Your existing ${counts.total} case${counts.total === 1 ? '' : 's'}${counts.approved > 0 ? ` (${counts.approved} approved)` : ''} stay available in history.`;
    } else {
      headline = 'Generating…';
      supportingCopy = 'Reading your requirements and proposing scenarios. This usually takes 30–90 seconds.';
    }
  } else if (counts.total === 0) {
    headline = 'Awaiting scenarios.';
    supportingCopy = 'Generate scenarios from your requirements to start the review.';
    tone = 'info';
  } else if (counts.approved === 0) {
    headline = 'Review.';
    supportingCopy = `${counts.scenarios} scenario${counts.scenarios === 1 ? '' : 's'} · ${counts.total} test case${counts.total === 1 ? '' : 's'} ready for your eye. Approve the ones you want to run.`;
    tone = 'accent';
  } else if (running) {
    headline = 'Running.';
    supportingCopy = 'A live execution is already active. You can keep refining, batching, and reviewing cases while it runs.';
    tone = 'info';
  } else if (counts.approved === counts.total) {
    headline = counts.runReady === counts.total ? 'Ready.' : 'Approved.';
    supportingCopy = counts.runReady === counts.total
      ? `All ${counts.total} case${counts.total === 1 ? ' is' : 's are'} approved and run-ready.`
      : `All ${counts.total} case${counts.total === 1 ? ' is' : 's are'} approved. ${counts.approvedBlocked} have readiness warnings, but Run is available if you want to proceed.`;
    tone = counts.runReady === counts.total ? 'success' : 'warn';
  } else if (canRun) {
    headline = `${counts.approved} approved.`;
    supportingCopy = counts.approvedBlocked
      ? `${counts.runReady} run-ready; ${counts.approvedBlocked} approved case${counts.approvedBlocked === 1 ? ' has' : 's have'} readiness warnings. You can proceed or regenerate after reviewing the warning.`
      : `${counts.approved} approved and run-ready. Run them now or keep approving.`;
    tone = 'info';
  } else {
    headline = 'Reviewing…';
    supportingCopy = `${counts.approved} approved · ${counts.pending} still pending · ${counts.rejected} rejected.`;
    tone = 'info';
  }

  // Override the gauge with generation progress when generating; otherwise show approval.
  const showingGenGauge = !!generating;
  const showingScenarioGauge = scenarioOperation?.status === 'running';
  const gaugeValue = showingScenarioGauge ? scenarioOperation.progress || 8 : showingGenGauge ? generationRingFill : approvalPct;
  const gaugeTone = (showingGenGauge || showingScenarioGauge) ? 'accent' : tone;
  const gaugeStroke = SIGNAL[gaugeTone] || SIGNAL.info;
  const gaugeRadius = 94;
  const gaugeCircumference = 2 * Math.PI * gaugeRadius;
  const gaugeOffset = gaugeCircumference - (Math.max(0, Math.min(100, gaugeValue)) / 100) * gaugeCircumference;

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      className="glass relative overflow-hidden p-7 md:p-9"
    >
      <div className="grid lg:grid-cols-[240px_1fr_auto] gap-8 lg:gap-10 items-center">
        {/* ── Gauge ─────────────────────────────────────────────── */}
        <div className="relative h-[220px] flex items-center justify-center">
          <svg className="h-[220px] w-[220px]" viewBox="0 0 220 220" role="img" aria-label={`${Math.round(gaugeValue)} percent approval gauge`}>
            <circle
              cx="110"
              cy="110"
              r={gaugeRadius}
              fill="none"
              stroke="rgba(15,23,42,0.06)"
              strokeWidth="16"
            />
            <motion.circle
              cx="110"
              cy="110"
              r={gaugeRadius}
              fill="none"
              stroke={gaugeStroke}
              strokeWidth="16"
              strokeLinecap="round"
              strokeDasharray={gaugeCircumference}
              strokeDashoffset={gaugeOffset}
              initial={false}
              animate={{ strokeDashoffset: gaugeOffset }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              style={{ transform: 'rotate(-90deg)', transformOrigin: '110px 110px' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            {showingScenarioGauge ? (
              <>
                <div className={`text-4xl font-extrabold tabular-nums tracking-tight ${TONE_TEXT.accent}`}>
                  <AnimatedNumber value={Math.round(gaugeValue)} suffix="%" />
                </div>
                <div className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500 mt-1">
                  {scenarioOperation.type === 'refine' ? 'refining' : 'regenerating'}
                </div>
                <div className="text-2xs text-ink-500 mt-1 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  targeted
                </div>
              </>
            ) : showingGenGauge ? (
              <>
                <div className={`text-5xl font-extrabold tabular-nums tracking-tight ${TONE_TEXT.accent}`}>
                  <AnimatedNumber value={scenariosSoFar} />
                </div>
                <div className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500 mt-1">
                  scenario{scenariosSoFar === 1 ? '' : 's'}
                </div>
                <div className="text-2xs text-ink-500 mt-1 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  streaming…
                </div>
              </>
            ) : (
              <>
                <div className={`text-4xl font-extrabold tracking-tight ${TONE_TEXT[tone]}`}>
                  <AnimatedNumber value={approvalPct} suffix="%" />
                </div>
                <div className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500 mt-1">
                  approved
                </div>
                {counts.total > 0 && (
                  <div className="text-2xs text-ink-500 mt-1 tabular-nums">
                    {counts.approved} of {counts.total}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Verdict copy ──────────────────────────────────────── */}
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-[0.22em] font-bold text-ink-500 mb-3 flex items-center gap-1.5">
            <ListChecks className="w-3 h-3" />
            Test cases
          </div>
          <motion.h2
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
            className={`font-display text-[64px] md:text-[76px] leading-[0.95] tracking-tight ${TONE_TEXT[tone]}`}
          >
            {headline}
          </motion.h2>
          <p className="mt-4 text-base text-ink-700 max-w-2xl leading-relaxed">
            {supportingCopy}
          </p>

          {/* Action chip rail — hidden during regeneration; the Scenario
              Architect banner above carries the live elapsed timer + Terminate. */}
          {counts.total > 0 && !generating && (
            <div className="mt-5 flex items-center gap-2 flex-wrap">
              <ActionChip
                icon={Sparkles}
                label="Generate"
                loading={generating}
                onClick={onGenerate}
                tone="accent"
              />
              <ActionChip
                icon={Zap}
                label="Smart-select"
                loading={selecting}
                onClick={onSmartSelect}
                tone="info"
              />
              {hasImpacted && (
                <ActionChip
                  icon={Target}
                  label={`Approve impacted (${impactedPendingCount})`}
                  loading={approving}
                  onClick={onApproveImpacted}
                  tone="warn"
                />
              )}
              {counts.pending > 0 && (
                <ActionChip
                  icon={ThumbsUp}
                  label="Approve all pending"
                  loading={approving}
                  onClick={onApproveAll}
                  tone="success"
                />
              )}
            </div>
          )}
        </div>

        {/* ── Run CTA ───────────────────────────────────────────── */}
        <div className="flex flex-col items-stretch lg:items-end gap-2 lg:min-w-[200px]">
          <motion.button
            type="button"
            onClick={onExecute}
            disabled={!canRun || generating}
            whileHover={(canRun && !generating) ? { scale: 1.02 } : {}}
            whileTap={(canRun && !generating) ? { scale: 0.98 } : {}}
            title={generating
              ? 'Regeneration in progress — Run is disabled until it finishes or is cancelled'
              : canRun
                ? `Run ${counts.approved} approved test case${counts.approved === 1 ? '' : 's'}${counts.approvedBlocked ? ' with readiness warning(s)' : ''}`
                : counts.approved > 0 ? 'Run is unavailable while another run is active' : 'Approve at least one case to enable Run'}
            className={`relative group overflow-hidden rounded-2xl px-7 py-5 text-left transition-all duration-300 ${
              (canRun && !generating)
                ? 'bg-ink-900 text-white shadow-[0_24px_48px_-12px_rgba(15,23,42,0.40)] hover:shadow-[0_32px_56px_-12px_rgba(15,23,42,0.50)]'
                : 'bg-ink-100 text-ink-400 cursor-not-allowed'
            }`}
          >
            {/* Aurora glow on the active state */}
            {(canRun && !generating) && (
              <span
                aria-hidden="true"
                className="absolute inset-0 opacity-40 blur-2xl"
                style={{
                  background:
                    'radial-gradient(circle at 30% 30%, #10b981 0%, transparent 60%), radial-gradient(circle at 70% 70%, #3b82f6 0%, transparent 60%)',
                }}
              />
            )}
            <div className="relative">
              <div className="text-2xs uppercase tracking-[0.22em] font-bold opacity-70 mb-2 flex items-center gap-2">
                {executing && <Loader2 className="w-3 h-3 animate-spin" />}
                {generating ? 'Paused' : executing ? 'Starting…' : hasRuns ? 'Suite execution' : 'Live execution'}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-display text-[44px] leading-none italic">
                  {generating ? 'Building' : executing ? 'Running' : hasRuns ? 'Rerun' : 'Run'}
                </span>
                {!generating && (
                  <span className="text-2xl font-bold tabular-nums opacity-90">
                    {counts.approved > 0 ? counts.approved : ''}
                  </span>
                )}
                {!executing && !generating && <Play className="w-5 h-5 fill-current opacity-80 group-hover:translate-x-0.5 transition-transform" />}
              </div>
              <div className="text-xs opacity-75 mt-2">
                {generating
                  ? 'New cases on the way…'
                  : canRun
                  ? counts.approvedBlocked
                    ? `${counts.approvedBlocked} readiness warning${counts.approvedBlocked === 1 ? '' : 's'} - user choice`
                    : `${counts.approved} approved case${counts.approved === 1 ? '' : 's'} - new run`
                  : counts.total === 0
                  ? 'Generate scenarios first'
                  : counts.approved > 0 ? 'Run unavailable during active work' : 'Approve at least one case'}
              </div>
            </div>
          </motion.button>
          {runCostEstimate && counts.approved > 0 && !generating && (
            <span
              className="text-2xs text-ink-500 tabular-nums lg:text-right"
              title="Estimated Conductor cost (1× to 3× attempts) + wall-clock duration"
            >
              ~${runCostEstimate.lowUsd.toFixed(2)}–${runCostEstimate.highUsd.toFixed(2)}
              {' · '}
              ~{Math.round(runCostEstimate.seconds / 60)} min
            </span>
          )}
        </div>
      </div>
    </motion.section>
  );
}

function ActionChip({ icon: Icon, label, onClick, loading, tone = 'ink', kbd }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-pill border text-xs font-semibold backdrop-blur-sm transition-all hover:translate-y-[-1px] disabled:opacity-50 disabled:translate-y-0 ${TONE_BG[tone]} ${TONE_TEXT[tone]} focus-visible:outline-none focus-visible:shadow-ring`}
    >
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
      {label}
      {kbd && (
        <kbd className="ml-1 text-2xs font-mono opacity-60 border border-current/30 rounded px-1">
          {kbd}
        </kbd>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionStrip — the status filter row. Each pill is BOTH a stat and a
// filter trigger. Active pill outlined ink-900. Tones are restrained — only
// the icon carries colour so the row reads as a coherent strip.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// AddScenarioModal — "+ Add scenario": the user describes a specific test (often a
// complex multi-step journey with forms & dropdowns) and QAAI APPENDS it to the
// current suite, grounded in the verified site atlas + uploaded test data. The
// "end-to-end journey" toggle tells the architect to author ONE chained flow
// instead of decomposing into atomic cases.
// ─────────────────────────────────────────────────────────────────────────────
function AddScenarioModal({ open, onClose, onSubmit, onInterpret, submitting, interpreting, scenarios = [] }) {
  const [design, setDesign] = useState('');
  const [journey, setJourney] = useState(true);
  const [forceAtlasRefresh, setForceAtlasRefresh] = useState(false);
  const continuationOptions = useMemo(() => (
    (Array.isArray(scenarios) ? scenarios : []).flatMap((scenario) => (
      (Array.isArray(scenario?.cases) ? scenario.cases : []).map((testCase) => ({
        id: testCase.id,
        scenarioId: scenario.id,
        label: `${testCase.name || 'Untitled case'}${scenario?.name ? ` - ${scenario.name}` : ''}`,
        status: testCase.status || 'pending',
        readinessStatus: testCase.readinessStatus || 'needs_review',
        sessionMode: testCase.sessionMode || 'fresh',
      })).filter((option) => option.id)
    ))
  ), [scenarios]);
  const [continueFromCase, setContinueFromCase] = useState(false);
  const [continuationParentCaseId, setContinuationParentCaseId] = useState('');
  useEffect(() => {
    if (!open) return;
    if (continuationOptions.length === 1) {
      setContinueFromCase(true);
      setContinuationParentCaseId(continuationOptions[0].id);
    } else if (!continuationOptions.some((option) => option.id === continuationParentCaseId)) {
      setContinuationParentCaseId('');
    }
  }, [open, continuationOptions, continuationParentCaseId]);
  if (!open) return null;
  const selectedContinuation = continuationOptions.find((option) => option.id === continuationParentCaseId) || null;
  const busy = submitting || interpreting;
  const canSubmit = design.trim().length > 0 && (!continueFromCase || !!selectedContinuation) && !busy;
  const requestPayload = {
    design,
    journey,
    continuationParentCaseId: continueFromCase ? selectedContinuation?.id || null : null,
    continuationParentScenarioId: continueFromCase ? selectedContinuation?.scenarioId || null : null,
    continuationSessionMode: continueFromCase ? 'continue_from_dependency' : null,
    forceAtlasRefresh,
  };
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm px-4"
      onClick={() => { if (!busy) onClose(); }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="max-h-[min(90vh,860px)] w-full max-w-2xl overflow-y-auto rounded-[22px] border border-white/70 bg-white/95 p-5 shadow-card backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-pill bg-accent-50 text-accent-600 shrink-0">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-ink-950">Add test design</h2>
            <p className="mt-0.5 text-sm text-ink-500">
              Paste a messy paragraph, structured flow, or inline test data. QAAI will preserve it and interpret the actions, values, and expected results.
            </p>
          </div>
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-500">Describe the test flow</label>
        <textarea
          value={design}
          onChange={(e) => setDesign(e.target.value)}
          rows={6}
          autoFocus
          placeholder={'e.g. Log in as an authorized user, go to Settings -> Users -> Add, select a role and status, choose a related record from autocomplete, enter the required account details, save, then log out, log back in as the new user, verify the dashboard, and log out again.'}
          className="mt-1.5 w-full rounded-2xl border border-ink-200/70 bg-white/90 p-3 text-sm text-ink-900 outline-none transition focus:border-accent-300 focus:shadow-ring resize-y"
        />
        <AuthoringAssist
          value={design}
          onChange={setDesign}
          disabled={busy}
        />

        <label className={`mt-3 flex items-start gap-2.5 select-none ${continuationOptions.length ? 'cursor-pointer' : 'cursor-not-allowed opacity-55'}`}>
          <input
            type="checkbox"
            checked={continueFromCase}
            disabled={!continuationOptions.length || busy}
            onChange={(e) => {
              const checked = e.target.checked;
              setContinueFromCase(checked);
              if (checked && !continuationParentCaseId && continuationOptions.length) {
                setContinuationParentCaseId(continuationOptions[0].id);
              }
            }}
            className="mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-300"
          />
          <span className="text-sm font-medium text-ink-700">
            Continue from an existing case/session
            <span className="block text-xs font-normal text-ink-400">
              Use this when the new scenario starts after a previous case, such as a post-login flow.
            </span>
          </span>
        </label>

        {continueFromCase && (
          <label className="mt-2 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Parent case</span>
            <select
              value={continuationParentCaseId}
              onChange={(e) => setContinuationParentCaseId(e.target.value)}
              disabled={busy}
              className="mt-1.5 w-full rounded-2xl border border-ink-200/70 bg-white/90 px-3 py-2.5 text-sm text-ink-800 outline-none transition focus:border-accent-300 focus:shadow-ring disabled:opacity-50"
            >
              <option value="">Choose the case this should continue from...</option>
              {continuationOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {selectedContinuation && (
              <span className="mt-1.5 block text-xs text-ink-400">
                The generated case will use sessionMode=continue_from_dependency and depend on this case.
              </span>
            )}
          </label>
        )}

        <label className="mt-3 flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={journey}
            onChange={(e) => setJourney(e.target.checked)}
            className="h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-300"
          />
          <span className="text-sm font-medium text-ink-700">
            Author as one end-to-end journey
            <span className="text-ink-400 font-normal"> — multi-step flow with forms & dropdowns, chained data (recommended for complex tests)</span>
          </span>
        </label>

        <label className="mt-3 flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={forceAtlasRefresh}
            onChange={(e) => setForceAtlasRefresh(e.target.checked)}
            disabled={busy}
            className="mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-300"
          />
          <span className="text-sm font-medium text-ink-700">
            Rebuild the site atlas before authoring
            <span className="block text-xs font-normal text-ink-400">
              Off by default. Keep it off to reuse the current compatible atlas; enable only when the application UI has materially changed.
            </span>
          </span>
        </label>

        <div className="mt-4 rounded-2xl border border-info-200 bg-info-50 px-3.5 py-3 text-xs leading-relaxed text-info-800">
          QAAI accepts the description as written. The interpretation preview is optional and never prevents you from continuing with generation.
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            disabled={busy}
            className="inline-flex h-10 items-center rounded-pill border border-ink-200/70 bg-white/78 px-4 text-sm font-semibold text-ink-700 transition hover:bg-white disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onInterpret(requestPayload)}
            disabled={!canSubmit}
            className="inline-flex h-10 items-center gap-1.5 rounded-pill border border-accent-200 bg-white px-4 text-sm font-semibold text-accent-700 transition hover:bg-accent-50 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {interpreting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Bot className="h-4 w-4" aria-hidden="true" />}
            {interpreting ? 'Preparing preview…' : 'Preview interpretation'}
          </button>
          <button
            type="button"
            onClick={() => onSubmit(requestPayload)}
            disabled={!canSubmit}
            className="inline-flex h-10 items-center gap-1.5 rounded-pill bg-accent-600 px-4 text-sm font-semibold text-white transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
            {submitting ? 'Preparing test design…' : 'Continue with this flow'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function InterpretationPreviewModal({
  preview,
  onClose,
  onRefine,
  onApprove,
  onContinue,
  refining = false,
  approving = false,
}) {
  const [guidance, setGuidance] = useState('');
  useEffect(() => { setGuidance(''); }, [preview?.interpretation]);
  if (!preview) return null;
  const interpretation = preview.interpretation && typeof preview.interpretation === 'object'
    ? preview.interpretation
    : null;
  const deterministicMode = preview.mode === 'deterministic_interpretation_preview';
  const deterministicOperations = Array.isArray(interpretation?.logicalSteps)
    ? interpretation.logicalSteps.flatMap((logicalStep) => {
        const atomicActions = Array.isArray(logicalStep?.atomicActions) && logicalStep.atomicActions.length
          ? logicalStep.atomicActions
          : [{
              id: logicalStep?.id,
              text: logicalStep?.authoredText,
              type: 'SemanticInstruction',
              kind: logicalStep?.role,
            }];
        return atomicActions.map((atomicAction) => ({
          ...atomicAction,
          id: atomicAction?.id || logicalStep?.id,
          kind: atomicAction?.kind === 'assertion' || logicalStep?.role === 'assertion' ? 'assertion' : 'action',
          target: atomicAction?.text || logicalStep?.authoredText || 'Preserved user instruction',
          logicalStepId: logicalStep?.logicalStepId || logicalStep?.id,
          reason: logicalStep?.interpretationMode === 'semantic_fallback'
            ? 'The exact instruction is preserved for adaptive execution.'
            : 'Deterministically interpreted from the supplied flow.',
        }));
      })
    : [];
  const operations = Array.isArray(interpretation?.operations) && interpretation.operations.length
    ? interpretation.operations
    : deterministicOperations;
  const questions = Array.isArray(interpretation?.questions) ? interpretation.questions : [];
  const renderValue = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  };
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/45 backdrop-blur-sm px-4 py-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-white/70 bg-white shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-6 py-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-accent-50 text-accent-700">
              <Bot className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-xl font-bold text-ink-950">QAAI interpretation preview</h2>
              <p className="mt-1 text-sm text-ink-500">See how QAAI understood the pasted test before any compiler or validation contract is applied.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-pill p-2 text-ink-400 transition hover:bg-ink-50 hover:text-ink-700" aria-label="Close interpretation preview">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          <div className="rounded-2xl border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-800">
            Observation only: nothing was saved, no draft was registered, and Conductor was not called.
          </div>

          {preview.providerMessage ? (
            <div className="mt-3 rounded-2xl border border-info-200 bg-info-50 px-4 py-3 text-sm text-info-800">
              {preview.providerMessage}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-ink-500">
            <span className="rounded-pill bg-ink-50 px-3 py-1.5">
              {deterministicMode || preview.parseStatus === 'parsed'
                ? `${operations.length} interpreted operations`
                : 'Raw provider output'}
            </span>
            <span className="rounded-pill bg-ink-50 px-3 py-1.5">{preview.diagnostics?.durationMs ?? '?'} ms</span>
            <span className="rounded-pill bg-ink-50 px-3 py-1.5">{preview.diagnostics?.model || preview.diagnostics?.provider || 'configured model'}</span>
            {interpretation?.confidence && <span className="rounded-pill bg-ink-50 px-3 py-1.5">Confidence: {interpretation.confidence}</span>}
          </div>

          {interpretation ? (
            <>
              <section className="mt-5 rounded-2xl border border-ink-100 bg-ink-50/50 p-4">
                <h3 className="text-base font-bold text-ink-900">{interpretation.title || 'Untitled interpretation'}</h3>
                {interpretation.intentSummary && <p className="mt-1 text-sm text-ink-600">{interpretation.intentSummary}</p>}
                {interpretation.session && (
                  <dl className="mt-3 grid gap-2 text-xs text-ink-600 sm:grid-cols-2">
                    <div><dt className="font-semibold text-ink-800">Session</dt><dd>{interpretation.session.mode || 'unspecified'}</dd></div>
                    <div><dt className="font-semibold text-ink-800">Predecessor</dt><dd>{interpretation.session.predecessorCaseId || 'none'}</dd></div>
                    <div><dt className="font-semibold text-ink-800">Initial state</dt><dd>{interpretation.session.initialState || 'unspecified'}</dd></div>
                    <div><dt className="font-semibold text-ink-800">Final state</dt><dd>{interpretation.session.finalState || 'unspecified'}</dd></div>
                  </dl>
                )}
              </section>

              <section className="mt-5">
                <h3 className="text-sm font-bold uppercase tracking-wide text-ink-600">Interpreted operations</h3>
                <div className="mt-2 space-y-2">
                  {operations.map((operation, index) => {
                    const value = renderValue(operation.value);
                    const expected = renderValue(operation.expected);
                    const criteria = renderValue(operation.selectionCriteria);
                    return (
                      <article key={operation.id || `${operation.ordinal || index + 1}-${index}`} className="rounded-2xl border border-ink-100 bg-white p-3.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-pill bg-accent-50 px-2 text-xs font-bold text-accent-700">{operation.ordinal || index + 1}</span>
                          <span className="rounded-pill bg-ink-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500">{operation.kind || 'operation'}</span>
                          <strong className="text-sm text-ink-900">{operation.type || 'Unclassified'}</strong>
                          {operation.nonBlocking === true && <span className="rounded-pill bg-warn-50 px-2 py-1 text-[11px] font-semibold text-warn-700">Continue on mismatch</span>}
                          {!deterministicMode ? (
                            <button
                              type="button"
                              onClick={() => setGuidance(`Change operation ${operation.id || operation.ordinal || index + 1}: `)}
                              className="ml-auto rounded-pill border border-accent-200 bg-accent-50 px-2.5 py-1 text-[11px] font-semibold text-accent-700 transition hover:bg-accent-100"
                            >
                              Refine this operation
                            </button>
                          ) : null}
                        </div>
                        <p className="mt-2 text-sm text-ink-700">{operation.target || 'No target identified'}</p>
                        {(value || criteria || expected) && (
                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            {value && <span className="rounded-lg bg-info-50 px-2.5 py-1.5 text-info-800"><b>Value:</b> {value}</span>}
                            {criteria && <span className="rounded-lg bg-accent-50 px-2.5 py-1.5 text-accent-800"><b>Selection:</b> {criteria}</span>}
                            {expected && <span className="rounded-lg bg-success-50 px-2.5 py-1.5 text-success-800"><b>Expected:</b> {expected}</span>}
                          </div>
                        )}
                        {operation.condition && <p className="mt-2 text-xs text-warn-700"><b>Condition:</b> {operation.condition}</p>}
                        {operation.reason && <p className="mt-1 text-xs text-ink-400">{operation.reason}</p>}
                      </article>
                    );
                  })}
                  {!operations.length && <p className="rounded-2xl border border-warn-200 bg-warn-50 p-4 text-sm text-warn-800">QAAI returned structured data but no operations.</p>}
                </div>
              </section>

              {!!questions.length && (
                <section className="mt-5 rounded-2xl border border-warn-200 bg-warn-50 p-4">
                  <h3 className="text-sm font-bold text-warn-900">Questions QAAI identified while interpreting</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-warn-800">
                    {questions.map((question, index) => <li key={index}>{renderValue(question)}</li>)}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <section className="mt-5 rounded-2xl border border-warn-200 bg-warn-50 p-4">
              <h3 className="text-sm font-bold text-warn-900">QAAI returned an unstructured interpretation</h3>
              <p className="mt-1 text-sm text-warn-800">The response remains visible below so its natural understanding can still be evaluated.</p>
            </section>
          )}

          <details className="mt-5 rounded-2xl border border-ink-100 bg-ink-50/50 p-4">
            <summary className="cursor-pointer text-sm font-semibold text-ink-700">Show raw interpretation output</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-ink-950 p-4 text-xs text-white">{preview.rawOutput || 'No raw output returned.'}</pre>
          </details>
        </div>

        <div className="border-t border-ink-100 px-6 py-4">
          {!deterministicMode ? (
            <>
              <label className="block text-sm font-semibold text-ink-800" htmlFor="interpretation-refinement">Tell QAAI what to change</label>
              <textarea
                id="interpretation-refinement"
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
                placeholder="Example: Change operation op-0042 into two operations: select Ship Date & Time, then verify it is selected. Keep every other operation unchanged."
                rows={3}
                disabled={refining || approving}
                className="mt-2 w-full resize-y rounded-2xl border border-ink-200 bg-white px-3.5 py-3 text-sm text-ink-900 outline-none transition focus:border-accent-400 focus:ring-2 focus:ring-accent-100 disabled:opacity-60"
              />
            </>
          ) : (
            <p className="text-sm text-ink-600">
              Continue with the preserved flow now. The optional template can still make future descriptions easier to scan.
            </p>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} disabled={refining || approving} className="inline-flex h-10 items-center rounded-pill border border-ink-200 bg-white px-5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-50">Close</button>
            {!deterministicMode ? (
              <button
                type="button"
                onClick={() => onRefine(guidance)}
                disabled={!guidance.trim() || refining || approving}
                className="inline-flex h-10 items-center gap-2 rounded-pill border border-accent-200 bg-accent-50 px-5 text-sm font-semibold text-accent-700 transition hover:bg-accent-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {refining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {refining ? 'Applying correction…' : 'Refine interpretation'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={deterministicMode ? onContinue : onApprove}
              disabled={!interpretation || !operations.length || refining || approving}
              className="inline-flex h-10 items-center gap-2 rounded-pill bg-success-600 px-5 text-sm font-semibold text-white transition hover:bg-success-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {approving
                ? 'Preparing scenario…'
                : (deterministicMode ? 'Continue with this flow' : 'Approve and add')}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AddScenarioPreviewModal({
  preview,
  refining,
  approving,
  onDiscard,
  onRefine,
  onApprove,
}) {
  const [showRefine, setShowRefine] = useState(false);
  const [guidance, setGuidance] = useState('');
  useEffect(() => {
    setShowRefine(false);
    setGuidance('');
  }, [preview?.draftId, preview?.digest]);
  if (!preview) return null;

  const cases = Array.isArray(preview.cases) ? preview.cases : [];
  const clarifications = Array.isArray(preview.clarifications) ? preview.clarifications : [];
  const refinementChanges = previewObject(preview.refinementChanges) || null;
  const changedOperations = previewArray(refinementChanges?.changed);
  const preservedOperations = previewArray(refinementChanges?.preserved);
  const coverage = preview.coverage || {};
  const approveDisabled = !preview.approval?.enabled || refining || approving;
  const approveTitle = preview.approval?.enabled
    ? 'Approve this reviewed draft'
    : preview.approval?.reason || 'Approval is not available until the draft approval endpoint is enabled and blocking clarifications are resolved.';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/45 backdrop-blur-sm px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-scenario-preview-title"
      onClick={() => { if (!refining && !approving) onDiscard(); }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-card backdrop-blur-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-ink-100 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-accent-50 text-accent-700">
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id="add-scenario-preview-title" className="text-xl font-bold text-ink-950">Review scenario draft</h2>
                <p className="mt-1 text-sm text-ink-500">
                  Review the interpreted actions, assertions, values, and source coverage before anything is added.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onDiscard}
              disabled={refining || approving}
              aria-label="Discard scenario draft"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-pill text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 disabled:opacity-45"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-info-200 bg-info-50 px-3 py-2.5 text-sm text-info-800">
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Current generation remains unchanged until this draft is explicitly approved.
              {preview.revision && <span className="ml-1 font-mono text-xs">Revision {preview.revision}</span>}
            </span>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {refinementChanges && (
            <section className="rounded-2xl border border-accent-200 bg-accent-50/50 p-4" aria-label="Refinement changes">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-900">Refinement changes</h3>
                <span className="text-xs text-ink-500">{changedOperations.length} changed / {preservedOperations.length} preserved</span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-2xs font-bold uppercase tracking-wide text-accent-700">Changed</div>
                  <ul className="mt-1.5 space-y-1.5">
                    {changedOperations.map((operation) => (
                      <li key={`${operation.key}:${operation.disposition}`} className="rounded-lg border border-accent-100 bg-white px-2.5 py-2 text-xs text-ink-700">
                        <span className="mr-1 font-semibold capitalize text-accent-700">{operation.disposition}:</span>{operation.label}
                      </li>
                    ))}
                    {changedOperations.length === 0 && <li className="text-xs text-ink-400">No operations changed.</li>}
                  </ul>
                </div>
                <div>
                  <div className="text-2xs font-bold uppercase tracking-wide text-success-700">Preserved</div>
                  <ul className="mt-1.5 space-y-1.5">
                    {preservedOperations.map((operation) => (
                      <li key={operation.key} className="rounded-lg border border-success-100 bg-white px-2.5 py-2 text-xs text-ink-700">{operation.label}</li>
                    ))}
                    {preservedOperations.length === 0 && <li className="text-xs text-ink-400">No unchanged operations were reported.</li>}
                  </ul>
                </div>
              </div>
            </section>
          )}

          {clarifications.length > 0 && (
            <section className="rounded-2xl border border-warn-200 bg-warn-50/70 p-4" aria-label="Clarifications">
              <div className="flex items-center gap-2 text-sm font-semibold text-warn-900">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {clarifications.length} item{clarifications.length === 1 ? '' : 's'} need review
              </div>
              <div className="mt-3 space-y-3">
                {clarifications.map((item) => (
                  <div key={item.id} className="rounded-xl border border-warn-200/80 bg-white/75 px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium text-ink-900">{item.question}</p>
                      <span className={`shrink-0 rounded-pill px-2 py-0.5 text-2xs font-bold uppercase tracking-wide ${item.blocking ? 'bg-danger-100 text-danger-700' : 'bg-info-100 text-info-700'}`}>
                        {item.blocking ? 'Blocking' : 'Review'}
                      </span>
                    </div>
                    {item.reason && <p className="mt-1 text-xs text-ink-500">{item.reason}</p>}
                    {item.sourceQuote && <p className="mt-2 rounded-lg bg-ink-50 px-2.5 py-2 text-xs text-ink-700">Source: {item.sourceQuote}</p>}
                    {item.options.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.options.map((option) => <span key={option} className="rounded-pill border border-ink-200 bg-white px-2 py-1 text-xs text-ink-700">{option}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {cases.length === 0 ? (
            <section className="rounded-2xl border border-warn-200 bg-warn-50/60 p-4 text-sm text-warn-900">
              The semantic draft is not executable yet. Review the clarification items, then use Refine to tell QAAI what to change.
            </section>
          ) : cases.map((testCase, caseIndex) => (
            <section key={testCase.id} className="overflow-hidden rounded-2xl border border-ink-200/80 bg-white">
              <div className="border-b border-ink-100 bg-ink-50/70 px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-2xs font-bold uppercase tracking-[0.16em] text-accent-700">Case {testCase.ordinal || caseIndex + 1}</div>
                    <h3 className="mt-1 text-base font-semibold text-ink-950">{testCase.title}</h3>
                    {testCase.intent && <p className="mt-1 text-sm text-ink-600">{testCase.intent}</p>}
                  </div>
                  <div className="rounded-xl border border-ink-200 bg-white px-3 py-2 text-right text-xs">
                    <div className="font-semibold text-ink-900">Session: {testCase.session.mode}</div>
                    <div className="mt-0.5 text-ink-500">{testCase.session.sameSession ? 'Continue in the same browser session' : 'Start with a fresh session'}</div>
                  </div>
                </div>
                {(testCase.session.predecessorCaseId || testCase.session.reason || testCase.initialState || testCase.expectedFinalState) && (
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    {testCase.session.predecessorCaseId && <div><dt className="font-semibold text-ink-500">Continues from</dt><dd className="mt-0.5 text-ink-800">{testCase.session.predecessorCaseId}</dd></div>}
                    {testCase.session.reason && <div><dt className="font-semibold text-ink-500">Session reason</dt><dd className="mt-0.5 text-ink-800">{testCase.session.reason}</dd></div>}
                    {testCase.initialState && <div><dt className="font-semibold text-ink-500">Initial state</dt><dd className="mt-0.5 text-ink-800">{testCase.initialState}</dd></div>}
                    {testCase.expectedFinalState && <div><dt className="font-semibold text-ink-500">Expected final state</dt><dd className="mt-0.5 text-ink-800">{testCase.expectedFinalState}</dd></div>}
                  </dl>
                )}
              </div>

              {testCase.dataBindings.length > 0 && (
                <div className="border-b border-ink-100 px-4 py-3">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-ink-500">Inline values</h4>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {testCase.dataBindings.map((binding) => (
                      <div key={binding.id} className="rounded-xl bg-ink-50 px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ink-800">{binding.name}</span>
                          <span className="text-2xs uppercase tracking-wide text-ink-400">{binding.classification}</span>
                        </div>
                        <div className="mt-1 break-all font-mono text-xs text-ink-700">{binding.value || binding.valueRef || 'No value supplied'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-0 lg:grid-cols-2 lg:divide-x lg:divide-ink-100">
                <div className="px-4 py-3">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-ink-500">Ordered actions ({testCase.actions.length})</h4>
                  <ol className="mt-2 space-y-2">
                    {testCase.actions.map((action) => (
                      <li key={action.id} className="rounded-xl border border-ink-100 px-3 py-2.5 text-sm">
                        <div className="flex items-start gap-2">
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-accent-50 px-1.5 text-2xs font-bold text-accent-700">{action.ordinal}</span>
                          <div className="min-w-0">
                            <div className="font-semibold text-ink-900">{action.type} <span className="font-normal text-ink-500">on</span> {action.target}</div>
                            {action.text && <div className="mt-0.5 text-xs text-ink-600">{action.text}</div>}
                            {(action.value || action.valueRef) && <div className="mt-1 break-all font-mono text-xs text-info-700">Value: {action.value || action.valueRef}</div>}
                          </div>
                        </div>
                      </li>
                    ))}
                    {testCase.actions.length === 0 && <li className="text-sm text-ink-400">No browser actions were proposed.</li>}
                  </ol>
                </div>
                <div className="border-t border-ink-100 px-4 py-3 lg:border-t-0">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-ink-500">Typed assertions ({testCase.assertions.length})</h4>
                  <ol className="mt-2 space-y-2">
                    {testCase.assertions.map((assertion) => (
                      <li key={assertion.id} className="rounded-xl border border-ink-100 px-3 py-2.5 text-sm">
                        <div className="flex items-start gap-2">
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-success-50 px-1.5 text-2xs font-bold text-success-700">{assertion.ordinal}</span>
                          <div className="min-w-0">
                            <div className="font-semibold text-ink-900">{assertion.type} <span className="font-normal text-ink-500">on</span> {assertion.target}</div>
                            {assertion.text && <div className="mt-0.5 text-xs text-ink-600">{assertion.text}</div>}
                            {assertion.expected && <div className="mt-1 text-xs text-success-800">Expected: {assertion.expected}</div>}
                            {assertion.comparator && <div className="mt-0.5 text-xs text-ink-500">Comparator: {assertion.comparator}</div>}
                            {assertion.nonBlocking && <div className="mt-1 text-2xs font-semibold uppercase tracking-wide text-info-700">Continue on mismatch</div>}
                          </div>
                        </div>
                      </li>
                    ))}
                    {testCase.assertions.length === 0 && <li className="text-sm text-ink-400">No typed assertions were proposed.</li>}
                  </ol>
                </div>
              </div>
            </section>
          ))}

          <section className="rounded-2xl border border-ink-200 bg-ink-50/60 p-4" aria-label="Source coverage">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink-900">Source coverage</h3>
              <span className="text-xs text-ink-500">
                {coverage.covered ?? 0} covered / {coverage.total ?? 0} total / {coverage.unresolved ?? 0} unresolved
              </span>
            </div>
            {preview.sourceCoverage.length > 0 && (
              <div className="mt-3 max-h-48 space-y-2 overflow-y-auto">
                {preview.sourceCoverage.map((entry) => (
                  <div key={entry.id} className="rounded-xl border border-ink-200/80 bg-white px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink-800">{entry.disposition}</span>
                      {entry.refId && <span className="font-mono text-ink-400">{entry.refId}</span>}
                    </div>
                    {entry.sourceQuote && <p className="mt-1 text-ink-600">{entry.sourceQuote}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>

          {showRefine && (
            <section className="rounded-2xl border border-accent-200 bg-accent-50/50 p-4">
              <label htmlFor="add-scenario-refinement" className="text-sm font-semibold text-ink-900">Tell QAAI what to change</label>
              <p className="mt-1 text-xs text-ink-500">Reference the exact step, value, assertion, or session decision. Only the draft is updated.</p>
              <textarea
                id="add-scenario-refinement"
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
                rows={4}
                autoFocus
                placeholder="Example: Keep the second organization option, but change the final assertion to verify the saved order number."
                className="mt-2 w-full resize-y rounded-xl border border-ink-200 bg-white p-3 text-sm text-ink-900 outline-none focus:border-accent-300 focus:shadow-ring"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setShowRefine(false)} disabled={refining} className="h-9 rounded-pill border border-ink-200 bg-white px-3 text-sm font-semibold text-ink-700 disabled:opacity-45">Cancel</button>
                <button type="button" onClick={() => onRefine(guidance.trim())} disabled={guidance.trim().length < 3 || refining} className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-accent-600 px-3 text-sm font-semibold text-white disabled:opacity-45">
                  {refining && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Update preview
                </button>
              </div>
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 bg-white px-6 py-4">
          <button type="button" onClick={onDiscard} disabled={refining || approving} className="inline-flex h-10 items-center rounded-pill border border-ink-200 bg-white px-4 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-45">Discard</button>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setShowRefine(true)} disabled={refining || approving} className="inline-flex h-10 items-center gap-1.5 rounded-pill border border-accent-200 bg-accent-50 px-4 text-sm font-semibold text-accent-700 transition hover:bg-accent-100 disabled:opacity-45">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Refine
            </button>
            <button type="button" onClick={onApprove} disabled={approveDisabled} title={approveTitle} className="inline-flex h-10 items-center gap-1.5 rounded-pill bg-success-600 px-4 text-sm font-semibold text-white transition hover:bg-success-700 disabled:cursor-not-allowed disabled:opacity-45">
              {approving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
              Approve
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );
}

function TestInventoryToolbar({
  scenariosCount,
  automationCount,
  manualCount,
  manualCompleted,
  searchQuery,
  setSearchQuery,
  onConfigureTrigger,
  onNewBatch,
  onAddScenario,
  onRefine,
  onToggleBulk,
  bulkMode,
  actionsDisabled,
  headlessMode,
  headlessSaving,
  onToggleHeadless,
}) {
  const totalCount = automationCount + manualCount;
  const subtitle = totalCount > 0
    ? `${scenariosCount} scenario${scenariosCount === 1 ? '' : 's'} · ${automationCount} automation${manualCount > 0 ? ` · ${manualCount} manual (${manualCompleted} complete)` : ''}`
    : 'Create and approve test cases before live execution';

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-[22px] border border-white/70 bg-white/82 backdrop-blur-xl shadow-card px-4 py-3"
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-ink-950">Test Cases</h1>
          <p className="mt-0.5 text-sm text-ink-500 truncate">{subtitle}</p>
        </div>

        <div className="xl:ml-auto flex flex-col gap-2 lg:flex-row lg:items-center">
          <label className="relative block min-w-0 lg:w-[320px]">
            <span className="sr-only">Search test cases</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search tests..."
              className="h-10 w-full rounded-pill border border-ink-200/70 bg-white/80 pl-9 pr-3 text-sm font-medium text-ink-900 outline-none transition focus:border-info-300 focus:bg-white focus:shadow-ring"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <GenerationPicker buttonClassName="h-10 border-white/70 bg-white/78" />
            <button
              type="button"
              onClick={onConfigureTrigger}
              className="inline-flex h-10 items-center gap-1.5 rounded-pill border border-ink-200/70 bg-white/78 px-3 text-sm font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-white focus-visible:outline-none focus-visible:shadow-ring"
            >
              <Zap className="h-4 w-4" aria-hidden="true" />
              Configure Trigger
            </button>
            <button
              type="button"
              onClick={onRefine}
              disabled={actionsDisabled}
              className="inline-flex h-10 items-center gap-1.5 rounded-pill border border-accent-200/70 bg-accent-50/80 px-3 text-sm font-semibold text-accent-700 transition hover:bg-accent-100 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:shadow-ring"
              title="Ask QAAI to strengthen, split, or refocus the selected test plan"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              Refine
            </button>
            <button
              type="button"
              onClick={onNewBatch}
              disabled={actionsDisabled}
              className="inline-flex h-10 items-center gap-1.5 rounded-pill border border-ink-200/70 bg-white/78 px-3 text-sm font-semibold text-ink-700 transition hover:border-info-300 hover:bg-white hover:text-info-700 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:shadow-ring"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New batch
            </button>
            <button
              type="button"
              onClick={onAddScenario}
              disabled={actionsDisabled}
              className="inline-flex h-10 items-center gap-1.5 rounded-pill border border-accent-200/70 bg-accent-50/80 px-3 text-sm font-semibold text-accent-700 transition hover:bg-accent-100 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:shadow-ring"
              title="Describe a specific test (e.g. a multi-step journey with forms & dropdowns); QAAI adds it to the current suite, grounded in the site atlas & test data"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Add scenario
            </button>
            <button
              type="button"
              onClick={onToggleBulk}
              aria-pressed={bulkMode}
              className={`inline-flex h-10 items-center gap-1.5 rounded-pill px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:shadow-ring ${
                bulkMode
                  ? 'bg-ink-900 text-white'
                  : 'border border-ink-200/70 bg-white/78 text-ink-700 hover:border-ink-300 hover:bg-white'
              }`}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {bulkMode ? 'Selecting' : 'Select'}
            </button>
            <button
              type="button"
              onClick={onToggleHeadless}
              disabled={headlessMode == null || headlessSaving}
              aria-pressed={!!headlessMode}
              title={headlessMode
                ? 'Live runs launch with no visible browser window. Click to switch to headed.'
                : 'Live runs launch a visible browser window. Click to switch to headless.'}
              className={`inline-flex h-10 items-center gap-1.5 rounded-pill border px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:shadow-ring ${
                headlessMode
                  ? 'border-accent-200/70 bg-accent-50/80 text-accent-700 hover:bg-accent-100'
                  : 'border-ink-200/70 bg-white/78 text-ink-700 hover:border-ink-300 hover:bg-white'
              }`}
            >
              {headlessMode ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Monitor className="h-4 w-4" aria-hidden="true" />}
              {headlessMode == null ? 'Browser mode…' : headlessMode ? 'Headless' : 'Headed'}
            </button>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function TriggerConfigModal({
  open,
  draft,
  setDraft,
  fixtures,
  approvedCount,
  smokeCount,
  loading,
  saving,
  onClose,
  onSave,
  onRunNow,
}) {
  const runScope = draft.runScope === 'smoke' ? 'smoke' : 'approved';
  const runMode = draft.runMode === 'sequential' ? 'sequential' : 'grouped';
  const execMode = draft.execMode === 'thorough' ? 'thorough' : 'fast';
  const selectedFixture = draft.defaultAuthFixtureId || '';
  const canRunNow = runScope === 'smoke' ? smokeCount > 0 : approvedCount > 0;

  const updateDraft = (patch) => setDraft((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  if (!open) return null;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/45 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="Configure test trigger"
    >
      <motion.section
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/70 bg-white shadow-[0_28px_80px_-32px_rgba(15,23,42,0.45)]"
      >
        <header className="shrink-0 flex items-start gap-3 border-b border-ink-100 bg-white px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink-900 text-white">
            <Zap className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-ink-900">Configure trigger</h2>
            <p className="mt-1 text-sm text-ink-500">
              Choose what this page runs and which existing execution profile it should save.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-ink-200 bg-white text-ink-500 transition hover:border-ink-300 hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-ring"
            aria-label="Close trigger settings"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center gap-2 rounded-lg border border-info-100 bg-info-50 px-3 py-2 text-sm font-medium text-info-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading trigger settings...
            </div>
          )}

          <section>
            <div className="mb-2">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-500">Run Target</h3>
              <p className="mt-0.5 text-xs text-ink-500">Pick the source for Save and run.</p>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <TriggerOption
                selected={runScope === 'approved'}
                icon={ListChecks}
                title="Approved cases"
                detail={`${approvedCount} approved case${approvedCount === 1 ? '' : 's'} will run through the normal live pipeline. Readiness warnings stay advisory.`}
                onClick={() => updateDraft({ runScope: 'approved' })}
              />
              <TriggerOption
                selected={runScope === 'smoke'}
                icon={Target}
                title="Current smoke selection"
                detail={smokeCount > 0
                  ? `${smokeCount} selected case${smokeCount === 1 ? '' : 's'} will run as a smoke batch.`
                  : 'Select smoke cases in the list first; this target is saved but cannot run yet.'}
                disabled={smokeCount === 0}
                onClick={() => updateDraft({ runScope: 'smoke' })}
              />
            </div>
          </section>

          <section>
            <div className="mb-2">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-500">Run Mode</h3>
              <p className="mt-0.5 text-xs text-ink-500">Controls how the saved plan is handed to the live Conductor.</p>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <TriggerOption
                selected={runMode === 'grouped'}
                icon={ListChecks}
                title="Planner grouped"
                detail="Keep QAAI's dependency-planner waves for the next run."
                onClick={() => updateDraft({ runMode: 'grouped' })}
              />
              <TriggerOption
                selected={runMode === 'sequential'}
                icon={Clock}
                title="Strict sequential"
                detail="Force one scenario per wave when app state is fragile."
                onClick={() => updateDraft({ runMode: 'sequential' })}
              />
            </div>
          </section>

          <section>
            <div className="mb-2">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-500">Execution Profile</h3>
              <p className="mt-0.5 text-xs text-ink-500">Saved to the project execution mode used by the Conductor.</p>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <TriggerOption
                selected={execMode === 'fast'}
                icon={Zap}
                title="Fast daily runs"
                detail="Lower retry budget for day-to-day iteration and cheaper feedback loops."
                onClick={() => updateDraft({ execMode: 'fast' })}
              />
              <TriggerOption
                selected={execMode === 'thorough'}
                icon={ShieldCheck}
                title="Thorough release runs"
                detail="Higher retry and review budget for release-gate confidence."
                onClick={() => updateDraft({ execMode: 'thorough' })}
              />
            </div>
          </section>

          <section>
            <div className="mb-2">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-500">Preparation Session</h3>
              <p className="mt-0.5 text-xs text-ink-500">Optional saved browser state for login-protected apps.</p>
            </div>
            <label className="block">
              <span className="sr-only">Default auth fixture</span>
              <select
                value={selectedFixture}
                onChange={(event) => updateDraft({ defaultAuthFixtureId: event.target.value })}
                className="h-11 w-full rounded-lg border border-ink-200 bg-white px-3 text-sm font-medium text-ink-900 outline-none transition focus:border-info-300 focus:shadow-ring"
              >
                <option value="">No preparation session</option>
                {fixtures.map((fixture) => (
                  <option key={fixture.id} value={fixture.id}>
                    {fixture.name}{fixture.environment ? ` · ${fixture.environment}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {fixtures.length === 0 && (
              <p className="mt-2 text-xs text-ink-500">
                No auth fixtures are saved yet. Add one from Test Accounts or Project Setup when the app needs login state.
              </p>
            )}
          </section>
        </div>

        <footer className="shrink-0 flex flex-col gap-2 border-t border-ink-100 bg-ink-50/60 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-ink-200 bg-white px-4 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:shadow-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-ink-200 bg-white px-4 text-sm font-semibold text-ink-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-ring"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save settings
          </button>
          <button
            type="button"
            onClick={onRunNow}
            disabled={saving || !canRunNow}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-ink-900 px-4 text-sm font-bold text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300 focus-visible:outline-none focus-visible:shadow-ring"
            title={!canRunNow ? 'No approved cases are available for the selected target.' : undefined}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
            Save and run
          </button>
        </footer>
      </motion.section>
    </motion.div>
  );
}

function TriggerOption({ selected, disabled = false, icon: Icon, title, detail, onClick }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`flex min-h-[88px] items-start gap-3 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:shadow-ring ${
        selected
          ? 'border-info-300 bg-info-50 text-ink-900 shadow-[0_18px_38px_-30px_rgba(37,99,235,0.55)]'
          : 'border-ink-200 bg-white text-ink-900 hover:border-ink-300 hover:bg-ink-50'
      } ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}
    >
      <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-info-600 text-white' : 'bg-ink-100 text-ink-600'}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-bold">
          {title}
          {selected && <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
        </span>
        <span className={`mt-1 block text-xs leading-relaxed ${selected ? 'text-ink-600' : 'text-ink-500'}`}>
          {detail}
        </span>
      </span>
    </button>
  );
}

function ExecutionStrip({ counts, statusFilter, onToggleStatus }) {
  if (counts.total === 0) return null;
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1, duration: 0.5 }}
      className="rounded-[22px] border border-white/70 bg-white/72 backdrop-blur-xl shadow-card p-3 flex items-center gap-1.5 flex-wrap"
    >
      <span className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500 mr-2 pl-1">
        Status
      </span>
      <ExecutionPill icon={CheckCircle2} tone="success" label="Passed"  value={counts.pass}     k="pass"     active={statusFilter} onClick={onToggleStatus} />
      <ExecutionPill icon={XCircle}      tone="danger"  label="Failed"  value={counts.fail}     k="fail"     active={statusFilter} onClick={onToggleStatus} />
      <ExecutionPill icon={Circle}       tone="warn"    label="Blocked" value={counts.blocked}  k="blocked"  active={statusFilter} onClick={onToggleStatus} />
      {counts.skipped > 0 && (
        <ExecutionPill icon={Circle}     tone="ink"     label="Skipped" value={counts.skipped}  k="skipped"  active={statusFilter} onClick={onToggleStatus} />
      )}
      <span className="mx-1 text-ink-300" aria-hidden="true">·</span>
      <ExecutionPill icon={Check}        tone="ink"     label="Approved" value={counts.approved} k="approved" active={statusFilter} onClick={onToggleStatus} />
      {counts.pending > 0 && (
        <ExecutionPill icon={Clock}      tone="ink"     label="Pending"  value={counts.pending}  k="pending"  active={statusFilter} onClick={onToggleStatus} />
      )}
      {counts.rejected > 0 && (
        <ExecutionPill icon={X}          tone="ink"     label="Rejected" value={counts.rejected} k="rejected" active={statusFilter} onClick={onToggleStatus} />
      )}
      {statusFilter && (
        <button
          onClick={() => onToggleStatus(statusFilter)}
          className="ml-auto text-2xs font-semibold text-info-700 hover:text-info-900 underline focus-visible:outline-none focus-visible:shadow-ring rounded px-1"
        >
          Clear status filter
        </button>
      )}
    </motion.section>
  );
}

function ExecutionPill({ icon: Icon, tone, label, value, k, active, onClick }) {
  const isActive = active === k;
  const isInteractive = value > 0;
  const iconCls = {
    success: 'text-success-600',
    danger:  'text-danger-600',
    warn:    'text-warn-600',
    info:    'text-info-600',
    ink:     'text-ink-500',
  }[tone] || 'text-ink-500';
  return (
    <button
      type="button"
      onClick={isInteractive ? () => onClick(k) : undefined}
      disabled={!isInteractive}
      aria-pressed={isInteractive ? isActive : undefined}
      className={`inline-flex items-center gap-1.5 px-2.5 h-8 rounded-pill border text-xs transition-all duration-200 ${
        isActive
          ? 'bg-ink-900 text-white border-ink-900 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.20)]'
          : isInteractive
          ? 'bg-white/60 border-white/70 text-ink-700 hover:bg-white/90 hover:border-ink-200 backdrop-blur-sm'
          : 'bg-transparent border-transparent text-ink-400 cursor-default'
      } focus-visible:outline-none focus-visible:shadow-ring`}
    >
      <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-white' : iconCls}`} aria-hidden="true" />
      <span className={isActive ? '' : 'text-ink-600'}>{label}</span>
      <span className={`font-bold tabular-nums ${isActive ? 'text-white' : 'text-ink-900'}`}>{value}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FilterRail — Priority + Type + Confidence as glass-soft segmented controls.
// Each row is a label + chips so the user can scan axes at a glance.
// ─────────────────────────────────────────────────────────────────────────────
function FilterRail({
  counts, scenarios, filter, setFilter, confidenceMin, setConfidenceMin,
  visibleCaseCount, hiConfCount80, hiConfCount90, onClearAll,
}) {
  if (counts.total === 0) return null;
  const typeKeys = Object.keys(CATEGORY_META).filter(
    (c) => scenarios.some((s) => s.category === c)
  );
  const anyActive = filter !== 'all' || confidenceMin;
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15, duration: 0.5 }}
      className="rounded-[22px] border border-white/70 bg-white/70 backdrop-blur-xl shadow-card p-4 space-y-3"
    >
      <FilterAxis label="Priority">
        <FilterPill k="all" label="All" count={counts.scenarios} active={filter} setActive={setFilter} />
        {['P0', 'P1', 'P2', 'P3'].map((p) =>
          counts.byPriority[p] ? (
            <FilterPill
              key={p}
              k={p}
              label={p}
              count={counts.byPriority[p]}
              active={filter}
              setActive={setFilter}
              tone={PRIORITY_TONE[p]}
            />
          ) : null
        )}
      </FilterAxis>
      {typeKeys.length > 0 && (
        <FilterAxis label="Type">
          {typeKeys.map((c) => {
            const n = scenarios.filter((s) => s.category === c).length;
            return n ? (
              <FilterPill
                key={c}
                k={c}
                label={CATEGORY_META[c].label}
                count={n}
                active={filter}
                setActive={setFilter}
              />
            ) : null;
          })}
        </FilterAxis>
      )}
      <FilterAxis label="Confidence">
        <FilterPill k={null} label="All"     count={visibleCaseCount} active={confidenceMin} setActive={setConfidenceMin} />
        <FilterPill k={80}   label="≥ 80%"   count={hiConfCount80}   active={confidenceMin} setActive={setConfidenceMin} />
        <FilterPill k={90}   label="≥ 90%"   count={hiConfCount90}   active={confidenceMin} setActive={setConfidenceMin} />
      </FilterAxis>
      {anyActive && (
        <div className="pt-1">
          <button
            onClick={onClearAll}
            className="text-xs font-semibold text-info-700 hover:text-info-900 underline focus-visible:outline-none focus-visible:shadow-ring rounded"
          >
            Clear all filters
          </button>
        </div>
      )}
    </motion.section>
  );
}

function FilterAxis({ label, children }) {
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500 shrink-0 w-20">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterPill({ k, label, count, active, setActive, tone }) {
  const isActive = active === k;
  // Active tone — when the filter has a category tone (P0=danger etc.), the
  // active state uses that token instead of the default ink-900. Strengthens
  // the visual link between filter and downstream chip colour.
  const activeStyle = tone
    ? `${TONE_BG[tone]} ${TONE_TEXT[tone]} border-current`
    : 'bg-ink-900 text-white border-ink-900';
  return (
    <button
      onClick={() => setActive(k)}
      aria-pressed={isActive}
      className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-pill border text-xs font-semibold transition-all duration-200 backdrop-blur-sm ${
        isActive
          ? activeStyle + ' shadow-[0_2px_8px_-2px_rgba(15,23,42,0.18)]'
          : 'bg-white/60 border-white/70 text-ink-700 hover:bg-white/90 hover:border-ink-200'
      } focus-visible:outline-none focus-visible:shadow-ring`}
    >
      {label}
      <span className={`tabular-nums ${isActive ? 'opacity-75' : 'text-ink-400'}`}>{count}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PhaseBanner — inline architect/analyst progress, glass styling.
// ─────────────────────────────────────────────────────────────────────────────
function MiniProgress({ value, tone = 'info', className = '' }) {
  const safe = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const fill = {
    success: 'bg-success-500',
    danger: 'bg-danger-500',
    warn: 'bg-warn-500',
    info: 'bg-info-500',
    accent: 'bg-accent-500',
    ink: 'bg-ink-500',
  }[tone] || 'bg-info-500';
  return (
    <div className={`h-1.5 overflow-hidden rounded-pill bg-ink-100/80 ${className}`} aria-hidden="true">
      <div
        className={`h-full rounded-pill ${fill} transition-[width] duration-300 ease-out`}
        style={{ width: `${safe}%` }}
      />
    </div>
  );
}

function ReviewListToolbar({
  visibleScenarioCount,
  visibleCaseCount,
  totalCaseCount,
  expandedCount,
  activeFilterCount,
  onExpandAll,
  onCollapseAll,
}) {
  if (totalCaseCount === 0) return null;
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.18, duration: 0.42 }}
      className="rounded-[22px] border border-white/70 bg-white/78 backdrop-blur-xl shadow-card px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-ink-900 text-white shadow-[0_12px_28px_-18px_rgba(15,23,42,0.75)]">
          <ListChecks className="w-4 h-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-bold text-ink-900">Review queue</div>
          <div className="text-xs text-ink-500 leading-relaxed">
            Showing <span className="font-semibold text-ink-800 tabular-nums">{visibleCaseCount}</span>
            {' '}of <span className="font-semibold text-ink-800 tabular-nums">{totalCaseCount}</span> cases across{' '}
            <span className="font-semibold text-ink-800 tabular-nums">{visibleScenarioCount}</span> scenarios
            {activeFilterCount > 0 && (
              <span className="ml-1 text-info-700">
                ({activeFilterCount} active filter{activeFilterCount === 1 ? '' : 's'})
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="md:ml-auto flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onExpandAll}
          disabled={visibleScenarioCount === 0 || expandedCount >= visibleScenarioCount}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-pill text-xs font-semibold text-ink-700 bg-white/70 border border-ink-200/70 hover:bg-white hover:border-accent-300 hover:text-accent-700 disabled:opacity-45 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:shadow-ring"
        >
          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          Expand all
        </button>
        <button
          type="button"
          onClick={onCollapseAll}
          disabled={expandedCount === 0}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-pill text-xs font-semibold text-ink-700 bg-white/70 border border-ink-200/70 hover:bg-white hover:border-ink-300 disabled:opacity-45 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:shadow-ring"
        >
          <Minus className="w-3.5 h-3.5" aria-hidden="true" />
          Collapse
        </button>
      </div>
    </motion.section>
  );
}

function PhaseBanner({ phase, status, log, elapsed, onTerminate, onDismiss }) {
  const phaseMeta = {
    architect: { label: 'Scenario Architect', Icon: Sparkles },
    analyst:   { label: 'Smart Selection',    Icon: Zap      },
  }[phase] || { label: phase, Icon: Loader2 };
  const PhaseIcon = phaseMeta.Icon;

  const visual = {
    running:    { tone: 'info',    title: phaseMeta.label,                   StatusIcon: Loader2,      spin: true  },
    cancelling: { tone: 'warn',    title: `Cancelling ${phaseMeta.label}…`,  StatusIcon: Loader2,      spin: true  },
    cancelled:  { tone: 'ink',     title: `${phaseMeta.label} cancelled`,    StatusIcon: StopCircle,   spin: false },
    complete:   { tone: 'success', title: `${phaseMeta.label} finished`,     StatusIcon: CheckCircle2, spin: false },
    error:      { tone: 'danger',  title: `${phaseMeta.label} failed`,       StatusIcon: XCircle,      spin: false },
  }[status] || { tone: 'ink', title: phaseMeta.label, StatusIcon: Circle, spin: false };
  const StatusIcon = visual.StatusIcon;
  const accent = {
    info:    'bg-info-500',
    warn:    'bg-warn-500',
    ink:     'bg-ink-400',
    success: 'bg-success-500',
    danger:  'bg-danger-500',
  }[visual.tone];

  return (
    <motion.section
      initial={{ opacity: 0, y: 8, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      role="status"
      aria-live="polite"
      className="glass relative overflow-hidden"
    >
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${accent}`} aria-hidden="true" />
      <div className="pl-5 pr-4 py-3.5 flex items-start gap-3">
        <StatusIcon className={`w-4 h-4 mt-0.5 shrink-0 ${TONE_TEXT[visual.tone]} ${visual.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <PhaseIcon className="w-3.5 h-3.5 text-ink-500" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink-900 tracking-tight">{visual.title}</span>
            {(status === 'running' || status === 'cancelling') && (
              <span className="ml-auto text-2xs font-mono tabular-nums text-ink-500">{elapsed}s</span>
            )}
          </div>
          {(status === 'running' || status === 'cancelling') && log && (
            <p className="text-xs text-ink-600 mt-1 leading-relaxed line-clamp-2">{log}</p>
          )}
          {status === 'cancelled' && (
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              Stopped after {elapsed}s. Nothing was persisted.
            </p>
          )}
          {status === 'error' && log && (
            <p className="text-xs text-danger-700 mt-1 leading-relaxed line-clamp-2">{log}</p>
          )}
        </div>
        {status === 'running' && (
          <button
            onClick={onTerminate}
            className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-pill text-xs font-semibold text-danger-700 bg-white/70 backdrop-blur border border-danger-200/60 hover:bg-danger-50 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
            title="Stop the agent. The in-flight request is aborted."
          >
            <StopCircle className="w-3.5 h-3.5" />
            Terminate
          </button>
        )}
        {status === 'cancelling' && (
          <span className="shrink-0 text-xs font-medium text-warn-700">Cancelling…</span>
        )}
        {(status === 'complete' || status === 'cancelled' || status === 'error') && (
          <button
            onClick={onDismiss}
            className="shrink-0 text-ink-400 hover:text-ink-700 transition-colors"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </motion.section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BulkBar — sticky-feeling glass strip when bulk-select is on.
// ─────────────────────────────────────────────────────────────────────────────
function BulkBar({
  selectedCount, totalVisible, onSelectAll, onClear, onApprove, onReject,
  onRemove, onDone,
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="glass border border-info-200/60 px-4 py-2.5 flex items-center gap-2 flex-wrap"
      style={{ background: 'linear-gradient(180deg, rgba(239,246,255,0.85) 0%, rgba(239,246,255,0.55) 100%)' }}
    >
      <span className="text-xs font-semibold text-info-900">
        <AnimatedNumber value={selectedCount} duration={0.4} /> selected
        <span className="text-info-600 font-normal"> · of {totalVisible} visible</span>
      </span>
      <button onClick={onSelectAll} className="text-2xs font-semibold text-info-700 hover:underline">
        Select all visible
      </button>
      <button onClick={onClear} className="text-2xs font-semibold text-info-700 hover:underline">
        Clear
      </button>
      <div className="ml-auto flex items-center gap-1.5 flex-wrap">
        <Button size="sm" variant="secondary" onClick={onApprove} disabled={!selectedCount}>
          <Check className="w-3.5 h-3.5" />
          Approve{selectedCount > 0 ? ` ${selectedCount}` : ''}
        </Button>
        <Button size="sm" variant="secondary" onClick={onReject} disabled={!selectedCount}>
          <X className="w-3.5 h-3.5" />
          Reject
        </Button>
        <Button size="sm" variant="secondary" onClick={onRemove} disabled={!selectedCount}>
          <Trash2 className="w-3.5 h-3.5" />
          Remove
        </Button>
        <button
          onClick={onDone}
          className="text-xs text-info-700 hover:underline ml-1"
          title="Exit bulk-select mode"
        >
          Done
        </button>
      </div>
    </motion.section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JustGeneratedBanner — congratulatory glass card with category breakdown.
// ─────────────────────────────────────────────────────────────────────────────
function JustGeneratedBanner({
  counts, scenarios, approving, onApproveAll, onDismiss,
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="glass relative overflow-hidden p-5"
    >
      {/* Accent glow underline */}
      <div
        aria-hidden="true"
        className="absolute -bottom-12 -left-12 w-48 h-48 rounded-full opacity-25 blur-3xl"
        style={{ background: 'radial-gradient(circle, #8b5cf6 0%, transparent 70%)' }}
      />
      <div className="relative flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent-100/70 border border-accent-200/60 inline-flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-accent-700" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-md font-semibold text-ink-900 tracking-tight">
            <AnimatedNumber value={counts.scenarios} /> scenarios · <AnimatedNumber value={counts.total} /> test cases ready.
          </h2>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            Each scenario expands to show its cases. Each case expands to show step-by-step actions.
            Approve the ones you want to run, then click <strong>Run</strong> above.
          </p>
          <div className="flex items-center gap-2 mt-3 flex-wrap text-2xs">
            {['P0', 'P1', 'P2', 'P3'].map((p) => {
              const n = counts.byPriority[p] || 0;
              return n > 0 ? (
                <span
                  key={p}
                  className={`inline-flex items-center gap-1 px-2 h-5 rounded-pill border font-semibold ${TONE_BG[PRIORITY_TONE[p]]} ${TONE_TEXT[PRIORITY_TONE[p]]}`}
                >
                  {p} <span className="tabular-nums opacity-70">{n}</span>
                </span>
              ) : null;
            })}
            <span className="text-ink-300">·</span>
            {Object.entries(CATEGORY_META).map(([k, v]) => {
              const n = scenarios.filter((s) => s.category === k).length;
              return n ? (
                <span key={k} className="inline-flex items-center gap-1 text-ink-600 font-medium">
                  <span className="tabular-nums">{n}</span> {v.label.toLowerCase()}
                </span>
              ) : null;
            })}
          </div>
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <Button size="sm" onClick={onApproveAll} loading={approving} disabled={approving || !counts.pending}>
            <ThumbsUp className="w-3.5 h-3.5" />
            Approve all
          </Button>
          <button
            onClick={onDismiss}
            className="text-2xs text-ink-500 hover:text-ink-900 underline text-center"
          >
            dismiss
          </button>
        </div>
      </div>
    </motion.section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ModuleBanner — accent-tinted glass strip when ?module= deep-link is active.
// ─────────────────────────────────────────────────────────────────────────────
function ModuleBanner({ moduleName, count, onClear }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="glass-soft px-4 py-2.5 flex items-center gap-2 border border-info-200/60"
    >
      <Target className="w-3.5 h-3.5 text-info-700 shrink-0" aria-hidden="true" />
      <span className="text-xs text-info-900">
        Filtered to module <span className="font-semibold">{moduleName}</span>
        {' · '}
        <span className="tabular-nums">
          {count} scenario{count === 1 ? '' : 's'}
        </span>
      </span>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-xs font-semibold text-info-700 hover:text-info-900 underline focus-visible:outline-none focus-visible:shadow-ring rounded"
      >
        Clear module filter
      </button>
    </motion.section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ScenarioCard — glass card with layout animation (so it can reorder on
// filter change with a smooth slide). Expands to a case list.
// ─────────────────────────────────────────────────────────────────────────────
function ScenarioCard({
  scenario, index, expanded, onToggle, onApproveCase, onRejectCase,
  refMap, bulkMode, bulkIds, onToggleBulk, onRegenerate, regenerating,
  operation, onRefineScenario, onRefineCase, stepStatusByTc, smokeIds, onToggleSmoke,
  caseOperations, onRestoreScenario, onRestoreCase, onDeleteScenario, deleting,
  activeHoverScenarioId, onHoverScenario, onAddStep, onSaveStep, onRemoveStep,
  onReorderSteps, onUndoStep,
}) {
  const pTone = PRIORITY_TONE[scenario.priority] || 'info';
  const cMeta = CATEGORY_META[scenario.category] || CATEGORY_META.positive;

  // Per-scenario TRACEABILITY — which user-story requirement clause(s) + test-data sheet(s) this
  // scenario covers, aggregated from its cases. A scenario with NO clause AND NO data trace (or a
  // rationale the Architect prefixed "[OUT OF SCOPE]") is flagged: generated from general knowledge,
  // not the user's uploaded documents/data. Every in-scope scenario shows what it proves.
  const parseReqRefs = (c) => {
    const r = c?.requirementRefs;
    if (!r) return [];
    if (Array.isArray(r)) return r;
    try { return JSON.parse(r) || []; } catch { return []; }
  };
  const coveredRefs = Array.from(new Set((scenario.cases || []).flatMap(parseReqRefs).map((s) => String(s).trim()).filter(Boolean)));
  const coveredSheets = Array.from(new Set((scenario.cases || []).map((c) => { const b = parseCaseDataBinding(c); return b && b.sheet; }).filter(Boolean)));
  const scenarioOutOfScope = /^\s*\[OUT OF SCOPE\]/i.test(scenario.rationale || '') || (coveredRefs.length === 0 && coveredSheets.length === 0);

  const passCount = scenario.cases.filter((c) => c.latestResult?.status === 'pass').length;
  const failCount = scenario.cases.filter((c) => c.latestResult?.status === 'fail').length;
  const blockCount = scenario.cases.filter((c) => c.latestResult?.status === 'blocked').length;
  const totalCount = scenario.cases.length;
  const pendCount = scenario.cases.filter((c) => c.status === 'pending').length;
  // CRIT-6: 'running' is a transient sub-state of 'approved'; count both so
  // a scenario mid-run doesn't flicker its approval %.
  const apprCount = scenario.cases.filter((c) => c.status === 'approved' || c.status === 'running').length;

  // Mini-ring shows pass rate when there's been activity, otherwise approval %.
  const measured = passCount + failCount + blockCount;
  const ringRate = measured > 0
    ? Math.round((passCount / measured) * 100)
    : totalCount > 0
    ? Math.round((apprCount / totalCount) * 100)
    : 0;
  const ringTone = measured > 0
    ? (ringRate >= 80 ? 'success' : ringRate >= 50 ? 'warn' : 'danger')
    : apprCount === totalCount && totalCount > 0
    ? 'success'
    : 'info';

  const [menuOpen, setMenuOpen] = useState(false);
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [hoverClearToken, setHoverClearToken] = useState(0);
  const menuRef = useRef(null);
  const articleNodeRef = useRef(null);
  const scenarioPointerInsideRef = useRef(false);
  const hoverOpenTimerRef = useRef(null);
  const hoverCloseTimerRef = useRef(null);
  const hoverIntentRef = useRef(null);
  const displayExpanded = expanded || hoverExpanded;
  const opRunning = operation?.status === 'running';
  const opDone = operation?.status === 'done';
  const opErrored = operation?.status === 'error';
  const opVerb = operation?.type === 'refine' ? 'Refining' : 'Regenerating';
  const opDoneLabel = operation?.type === 'refine' ? 'Refined' : 'Regenerated';
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);
  useEffect(() => () => {
    window.clearTimeout(hoverOpenTimerRef.current);
    window.clearTimeout(hoverCloseTimerRef.current);
  }, []);
  useLayoutEffect(() => {
    if (!hoverExpanded || !activeHoverScenarioId || activeHoverScenarioId === scenario.id) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    window.clearTimeout(hoverCloseTimerRef.current);
    setHoverClearToken((token) => token + 1);
    const activeScenarioNode = refMap?.current?.get(activeHoverScenarioId);
    if (!preserveElementViewportPosition(activeScenarioNode, 180)) {
      preserveViewportDuringCollapse(articleNodeRef.current, 180);
    }
    setHoverExpanded(false);
  }, [activeHoverScenarioId, hoverExpanded, refMap, scenario.id]);

  const openHoverScenario = useCallback(() => {
    window.clearTimeout(hoverCloseTimerRef.current);
    if (expanded || hoverExpanded) return;
    if (hoverOpenTimerRef.current) return;
    const reveal = () => {
      const remaining = hoverSuppressionRemaining();
      if (remaining > 0) {
        hoverOpenTimerRef.current = window.setTimeout(reveal, remaining + 60);
        return;
      }
      hoverOpenTimerRef.current = null;
      const node = articleNodeRef.current;
      const intent = hoverIntentRef.current;
      if (!node || !intent) return;
      const rect = node.getBoundingClientRect();
      if (scenarioPointerInsideRef.current && pointInsideRect(intent, rect)) {
        onHoverScenario?.(scenario.id);
        setHoverExpanded(true);
      }
    };
    hoverOpenTimerRef.current = window.setTimeout(reveal, hoverSuppressionRemaining() + 220);
  }, [expanded, hoverExpanded, onHoverScenario, scenario.id]);

  const closeHoverScenario = useCallback(() => {
    window.clearTimeout(hoverOpenTimerRef.current);
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverOpenTimerRef.current = null;
    hoverCloseTimerRef.current = null;
  }, []);

  const handleToggleScenario = useCallback(() => {
    if (displayExpanded) {
      setHoverClearToken((token) => token + 1);
      preserveViewportDuringCollapse(articleNodeRef.current, 420);
    }
    onToggle();
  }, [displayExpanded, onToggle]);

  const articleRef = useCallback((node) => {
    articleNodeRef.current = node;
    if (!refMap) return;
    if (node) refMap.current.set(scenario.id, node);
    else refMap.current.delete(scenario.id);
  }, [refMap, scenario.id]);

  return (
    <motion.article
      layout="position"
      ref={articleRef}
      data-scenario-id={scenario.id}
      onMouseEnter={(event) => {
        scenarioPointerInsideRef.current = true;
        hoverIntentRef.current = { x: event.clientX, y: event.clientY };
        openHoverScenario();
      }}
      onMouseMove={(event) => {
        scenarioPointerInsideRef.current = true;
        hoverIntentRef.current = { x: event.clientX, y: event.clientY };
        if (!displayExpanded) openHoverScenario();
      }}
      onMouseLeave={(event) => {
        scenarioPointerInsideRef.current = false;
        hoverIntentRef.current = { x: event.clientX, y: event.clientY };
        closeHoverScenario();
      }}
      onWheelCapture={() => {
        markHoverScrollActivity();
        window.clearTimeout(hoverCloseTimerRef.current);
      }}
      onFocus={(event) => {
        scenarioPointerInsideRef.current = true;
        const rect = event.currentTarget.getBoundingClientRect();
        hoverIntentRef.current = { x: rect.left + rect.width / 2, y: rect.top + 12 };
        openHoverScenario();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          scenarioPointerInsideRef.current = false;
          closeHoverScenario();
        }
      }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.35), duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={`group relative overflow-hidden rounded-[26px] border border-ink-200/65 bg-white/78 backdrop-blur-xl shadow-card transition-all duration-200 hover:border-ink-300/80 hover:shadow-[0_24px_70px_-40px_rgba(15,23,42,0.36)] [overflow-anchor:none] ${displayExpanded ? 'ring-1 ring-ink-300/70 bg-white/86' : ''}`}
    >
      {/* Kebab menu — anchored top-right, outside the expand-toggle button. */}
      <div
        className="absolute left-0 top-0 h-full w-1.5"
        style={{ background: 'rgba(148, 163, 184, 0.58)' }}
        aria-hidden="true"
      />
      <div ref={menuRef} className="absolute top-4 right-4 z-10">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          disabled={opRunning || regenerating || deleting}
          className="inline-flex items-center justify-center w-8 h-8 rounded-pill text-ink-500 hover:text-ink-900 hover:bg-white/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:shadow-ring"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Scenario actions"
          title="Scenario actions"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: -4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.96 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 mt-1 w-56 rounded-xl border border-white/70 bg-white/95 backdrop-blur-md shadow-[0_24px_48px_-12px_rgba(15,23,42,0.18)] py-1 text-sm"
            >
              <button
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onRegenerate?.();
                }}
                disabled={opRunning || regenerating}
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-ink-800 hover:bg-accent-50/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <RotateCw className="w-3.5 h-3.5 text-accent-600" />
                Regenerate this scenario
              </button>
              <button
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onRefineScenario?.(scenario);
                }}
                disabled={opRunning || regenerating}
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-ink-800 hover:bg-accent-50/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <MessageSquare className="w-3.5 h-3.5 text-accent-600" />
                Refine with AI...
              </button>
              {scenario.canRestorePrevious && (
                <button
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onRestoreScenario?.(scenario);
                  }}
                  disabled={opRunning || regenerating}
                  className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-ink-800 hover:bg-info-50/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border-t border-ink-100/80"
                >
                  <Undo2 className="w-3.5 h-3.5 text-info-600" />
                  Restore previous version
                </button>
              )}
              <button
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onDeleteScenario?.(scenario);
                }}
                disabled={opRunning || regenerating || deleting}
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-danger-700 hover:bg-danger-50/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border-t border-ink-100/80"
              >
                <Trash2 className="w-3.5 h-3.5 text-danger-600" />
                Delete scenario
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Regenerating banner — replaces the card's first row with an inline
          spinner. Doesn't unmount the card so the expand state survives. */}
      {opRunning && (
        <div className="px-6 py-2 border-b border-accent-200/60 bg-accent-50/70 text-xs text-accent-800">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="font-semibold">{opVerb} this scenario</span>
            <span className="text-accent-700/80">
              {scenario.cases.length} test case{scenario.cases.length === 1 ? '' : 's'} · {Math.round(operation.progress || 0)}%
            </span>
          </div>
          <MiniProgress value={operation.progress || 8} tone="accent" className="mt-2 max-w-sm" />
          {operation.message && (
            <div className="mt-1 text-[11px] text-accent-700/80">
              {operation.message}
            </div>
          )}
          <span className="sr-only">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Regenerating this scenario — the Architect is running…
          </span>
        </div>
      )}

      <button
        onClick={handleToggleScenario}
        className="w-full p-6 pr-16 text-left focus-visible:outline-none focus-visible:shadow-ring rounded-card"
        aria-expanded={displayExpanded}
        aria-controls={`scenario-${scenario.id}-body`}
      >
        {/* Meta row — priority chip carries the colour, supporting meta is neutral. */}
        <div className="flex items-center gap-2 mb-3 text-2xs font-semibold uppercase tracking-[0.14em]">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill border ${TONE_BG[pTone]} ${TONE_TEXT[pTone]}`}
          >
            {scenario.priority}
          </span>
          <span className="text-ink-500">{cMeta.label}</span>
          <span className="text-ink-300">·</span>
          <span className="text-ink-500">{scenario.module}</span>
          {scenario.impacted && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-warn-50/70 text-warn-700 border border-warn-200/60 normal-case tracking-normal backdrop-blur-sm"
              title={scenario.impactReason || 'Impacted by release notes'}
            >
              <Target className="w-3 h-3" />
              Impacted
            </span>
          )}
          {(opDone || opErrored) && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill border normal-case tracking-normal backdrop-blur-sm ${
                opErrored
                  ? 'bg-danger-50/80 text-danger-700 border-danger-200/70'
                  : 'bg-accent-50/80 text-accent-700 border-accent-200/70'
              }`}
              title={opErrored ? 'The last targeted update failed' : 'This scenario was updated in this session'}
            >
              {opErrored ? <AlertTriangle className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
              {opErrored ? 'Update failed' : opDoneLabel}
            </span>
          )}
        </div>

        {/* Title + right rail */}
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-ink-900 tracking-tight leading-snug">
              {scenario.scenarioLabel && (
                <span className="inline-flex items-center mr-2 px-1.5 py-0.5 rounded-md bg-accent-50 text-accent-700 border border-accent-200/70 text-2xs font-bold tabular-nums align-middle">
                  {scenario.scenarioLabel}
                </span>
              )}
              {scenario.name}
            </h3>
            {scenario.rationale && (
              <p className="text-sm text-ink-600 leading-relaxed mt-1.5 line-clamp-2">
                {scenario.rationale.replace(/^\s*\[OUT OF SCOPE\]\s*/i, '')}
              </p>
            )}
            {/* Traceability — every scenario shows the user story + test data it covers, or is
                explicitly flagged as out-of-scope (general knowledge). No unlabeled scenarios. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs normal-case tracking-normal">
              {scenarioOutOfScope ? (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-warn-50/80 text-warn-700 border border-warn-200/70"
                  title="This scenario is not traceable to your uploaded user stories or test data — it was generated from general knowledge. Supply matching requirements/data before relying on it."
                >
                  <AlertTriangle className="w-3 h-3" />
                  Out of scope — general knowledge (not in your user stories / test data)
                </span>
              ) : (
                <>
                  {coveredRefs.length > 0 && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-accent-50/80 text-accent-700 border border-accent-200/60"
                      title={`Covers requirement clause(s): ${coveredRefs.join(', ')}`}
                    >
                      <FileText className="w-3 h-3" />
                      Covers {coveredRefs.length} user-story clause{coveredRefs.length > 1 ? 's' : ''}: {coveredRefs.slice(0, 3).join(', ')}{coveredRefs.length > 3 ? ` +${coveredRefs.length - 3}` : ''}
                    </span>
                  )}
                  {coveredSheets.length > 0 && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-ink-50 text-ink-600 border border-ink-200/60"
                      title={`Data-driven from sheet(s): ${coveredSheets.join(', ')}`}
                    >
                      <ClipboardCheck className="w-3 h-3" />
                      Data: {coveredSheets.join(', ')}
                    </span>
                  )}
                </>
              )}
            </div>
            {scenario.impacted && scenario.impactReason && (
              <div className="text-xs text-warn-800 mt-2 leading-relaxed flex gap-1.5">
                <Target className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-semibold">Why impacted: </span>
                  {scenario.impactReason}
                </span>
              </div>
            )}
          </div>

          {/* Right rail — counts + mini ring */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="flex flex-col items-end gap-1 text-xs">
              {passCount > 0 && (
                <span className="inline-flex items-center gap-1 text-success-700 font-semibold tabular-nums">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {passCount} passed
                </span>
              )}
              {failCount > 0 && (
                <span className="inline-flex items-center gap-1 text-danger-700 font-semibold tabular-nums">
                  <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  {failCount} failed
                </span>
              )}
              {blockCount > 0 && (
                <span className="inline-flex items-center gap-1 text-warn-700 font-semibold tabular-nums">
                  <Circle className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                  {blockCount} blocked
                </span>
              )}
              {measured === 0 && (
                <span className="text-2xs text-ink-500 tabular-nums">
                  {pendCount > 0 ? `${pendCount} pending` : `${apprCount}/${totalCount} approved`}
                </span>
              )}
              <span className="text-2xs text-ink-400 tabular-nums">
                {totalCount} case{totalCount === 1 ? '' : 's'}
              </span>
            </div>

            <div className="w-28 rounded-2xl border border-white/70 bg-white/70 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-2xs uppercase tracking-[0.14em] font-bold text-ink-400">
                  {measured > 0 ? 'Pass' : 'Ready'}
                </span>
                <span className={`text-sm font-black tabular-nums ${TONE_TEXT[ringTone]}`}>
                  {ringRate}%
                </span>
              </div>
              <MiniProgress value={ringRate} tone={ringTone} className="mt-2" />
            </div>

            <ChevronRight
              className={`w-4 h-4 text-ink-400 transition-transform duration-200 ${displayExpanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            />
          </div>
        </div>
      </button>

      {/* Expanded body — case list. AnimatePresence so collapse is smooth. */}
      <AnimatePresence initial={false}>
        {displayExpanded && (
          <motion.div
            id={`scenario-${scenario.id}-body`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: expanded ? 0.3 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-white/60 [overflow-anchor:none]"
          >
            {scenario.dependencyOn?.length > 0 && (
              <div className="px-6 py-2.5 bg-white/30 border-b border-white/60 text-xs">
                <span className="font-semibold text-ink-700">Depends on: </span>
                <span className="text-ink-500">{scenario.dependencyOn.join(', ')}</span>
              </div>
            )}
            <ul className="divide-y divide-white/50">
              {scenario.cases.map((tc, i) => (
                <CaseRow
                  key={tc.id}
                  tc={tc}
                  index={i}
                  onApprove={() => onApproveCase(tc)}
                  onReject={() => onRejectCase(tc)}
                  bulkMode={bulkMode}
                  checked={bulkIds?.has(tc.id) || false}
                  onToggleBulk={() => onToggleBulk?.(tc.id)}
                  stepStatuses={stepStatusByTc?.[tc.id]}
                  smokeSelected={smokeIds?.has(tc.id) || false}
                  onToggleSmoke={onToggleSmoke ? () => onToggleSmoke(tc.id) : undefined}
                  onRefine={() => onRefineCase?.(scenario, tc)}
                  onRestore={() => onRestoreCase?.(tc)}
                  operation={caseOperations?.[tc.id]}
                  hoverClearToken={hoverClearToken}
                  onAddStep={(draft) => onAddStep?.(tc, draft)}
                  onSaveStep={(stepId, draft) => onSaveStep?.(tc, stepId, draft)}
                  onRemoveStep={(stepId, label) => onRemoveStep?.(tc, stepId, label)}
                  onReorderSteps={(stepIds) => onReorderSteps?.(tc, stepIds)}
                  onUndoStep={(stepId, undoToken) => onUndoStep?.(tc, stepId, undoToken)}
                />
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CaseRow — single test case. Status chip + name + assertions + actions.
// Expands to show steps.
// ─────────────────────────────────────────────────────────────────────────────
function groupLogicalSteps(steps = []) {
  const groups = [];
  const byId = new Map();
  for (const [sourceIndex, step] of (Array.isArray(steps) ? steps : []).entries()) {
    const key = stepLogicalIdentity(step, sourceIndex);
    let group = byId.get(key);
    if (!group) {
      group = {
        id: key,
        logicalOrdinal: Number(step?.logicalOrdinal) || groups.length + 1,
        authoredText: step?.authoredText || step?.text || '',
        steps: [],
      };
      byId.set(key, group);
      groups.push(group);
    }
    group.steps.push({ ...step, _sourceIndex: sourceIndex + 1 });
  }
  return groups;
}

function CaseRow({
  tc,
  index,
  onApprove,
  onReject,
  bulkMode,
  checked,
  onToggleBulk,
  stepStatuses,
  smokeSelected,
  onToggleSmoke,
  onRefine,
  onRestore,
  operation,
  hoverClearToken,
  onAddStep,
  onSaveStep,
  onRemoveStep,
  onReorderSteps,
  onUndoStep,
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [hoverStepsOpen, setHoverStepsOpen] = useState(false);
  const rowRef = useRef(null);
  const casePointerInsideRef = useRef(false);
  const stepOpenTimerRef = useRef(null);
  const stepCloseTimerRef = useRef(null);
  const showHoverStepPreview = hoverStepsOpen && !stepsOpen;
  const displayStepsOpen = stepsOpen || showHoverStepPreview;
  const displayStatus = tc.latestResult?.status || tc.status;
  const sm = statusMeta(displayStatus);
  const statusLabel = STATUS_DISPLAY[displayStatus] || sm.label;
  const typeLabel = TYPE_META[tc.type]?.label || tc.type;
  const steps = Array.isArray(tc.steps) ? tc.steps : [];
  const derivedLogicalStepCount = groupLogicalSteps(steps).length;
  const logicalStepCount = tc.logicalStepCount != null && Number.isFinite(Number(tc.logicalStepCount))
    ? Number(tc.logicalStepCount)
    : derivedLogicalStepCount;
  const improved = caseWasImproved(tc);
  const improvementFocus = caseImprovementFocus(tc);
  const improvedLabel = improvementFocus === 'step' ? 'Step improved' : 'Case improved';
  const improvedTitle = tc.updatedAt ? `Improved ${timeAgo(tc.updatedAt)}` : 'Improved with guidance';
  const refining = operation?.status === 'running';
  const bindingBadge = dataBindingBadge(parseCaseDataBinding(tc));
  const validationSummary = useMemo(
    () => validationSummaryForCase(tc),
    [tc.assertionCount, tc.declaredAssertionCount, tc.validationCount, tc.declaredAssertions, tc.assertions],
  );
  // CaseCompiler readiness chip — show ONLY when not 'ready' (blocked / needs_review)
  // so the user sees BEFORE approving that a case can't (or shouldn't yet) run. The
  // compiler is the promotion authority; this is its visible surface.
  const readiness = tc.compiledReadiness || null;
  const readinessBadge = (readiness && readiness.state && readiness.state !== 'ready')
    ? {
      label: readinessStatusLabel(readiness.readinessStatus || readiness.state),
      detail: [...(readiness.blockers || []).map((b) => b.code), ...(readiness.warnings || []).map((w) => w.code)].join(', ') || readiness.state,
      style: readiness.state === 'blocked'
        ? { background: 'rgba(244,63,94,0.10)', color: '#be123c', borderColor: 'rgba(244,63,94,0.35)' }
        : { background: 'rgba(245,158,11,0.12)', color: '#b45309', borderColor: 'rgba(245,158,11,0.35)' },
    }
    : null;
  useEffect(() => () => {
    window.clearTimeout(stepOpenTimerRef.current);
    window.clearTimeout(stepCloseTimerRef.current);
  }, []);
  useEffect(() => {
    window.clearTimeout(stepOpenTimerRef.current);
    window.clearTimeout(stepCloseTimerRef.current);
    casePointerInsideRef.current = false;
    setHoverStepsOpen(false);
  }, [hoverClearToken]);

  const openHoverSteps = useCallback((skipPointerCheck = false) => {
    window.clearTimeout(stepCloseTimerRef.current);
    if (stepsOpen || hoverStepsOpen || steps.length === 0) return;
    window.clearTimeout(stepOpenTimerRef.current);
    const reveal = () => {
      const remaining = hoverSuppressionRemaining();
      if (remaining > 0) {
        stepOpenTimerRef.current = window.setTimeout(reveal, remaining + 60);
        return;
      }
      stepOpenTimerRef.current = null;
      if (!skipPointerCheck && !casePointerInsideRef.current) return;
      setHoverStepsOpen(true);
    };
    stepOpenTimerRef.current = window.setTimeout(reveal, hoverSuppressionRemaining() + 260);
  }, [steps.length, stepsOpen, hoverStepsOpen]);

  const closeHoverSteps = useCallback(() => {
    window.clearTimeout(stepOpenTimerRef.current);
    window.clearTimeout(stepCloseTimerRef.current);
    const scheduleClose = (delay) => {
      stepCloseTimerRef.current = window.setTimeout(() => {
        if (casePointerInsideRef.current) return;
        markHoverScrollActivity();
        preserveViewportDuringCollapse(rowRef.current, 320);
        setHoverStepsOpen(false);
      }, delay);
    };
    if (hoverSuppressedByScroll()) {
      scheduleClose(Math.max(220, hoverScrollSuppressedUntil - Date.now() + 180));
      return;
    }
    scheduleClose(220);
  }, []);

  const toggleSteps = useCallback(() => {
    if (displayStepsOpen) {
      markHoverScrollActivity();
      preserveViewportDuringCollapse(rowRef.current, 320);
    }
    setHoverStepsOpen(false);
    setStepsOpen((v) => !v);
  }, [displayStepsOpen]);

  return (
    <motion.li
      ref={rowRef}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.2), duration: 0.3 }}
      className="relative last:border-b-0 [overflow-anchor:none]"
      onMouseEnter={() => {
        casePointerInsideRef.current = true;
        openHoverSteps();
      }}
      onMouseMove={() => {
        casePointerInsideRef.current = true;
        if (!displayStepsOpen) openHoverSteps();
      }}
      onMouseLeave={() => {
        casePointerInsideRef.current = false;
        window.clearTimeout(stepOpenTimerRef.current);
      }}
      onWheelCapture={() => {
        markHoverScrollActivity();
        window.clearTimeout(stepCloseTimerRef.current);
      }}
      onFocus={() => {
        casePointerInsideRef.current = true;
        openHoverSteps(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          casePointerInsideRef.current = false;
          closeHoverSteps();
        }
      }}
    >
      <div className={`group/case mx-4 my-2 rounded-2xl border border-ink-200/55 bg-white/48 px-4 py-3 transition-all hover:bg-white/72 hover:border-ink-300/65 ${checked ? 'bg-info-50/70 border-info-200/70' : ''}`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        {bulkMode && (
          <label className="mt-1 inline-flex items-center cursor-pointer" title="Select this case">
            <input
              type="checkbox"
              checked={!!checked}
              onChange={onToggleBulk}
              className="w-4 h-4 rounded border-ink-300 text-info-600 focus:ring-info-500 focus:ring-2 focus:ring-offset-0"
              aria-label={`Select ${tc.name}`}
            />
          </label>
        )}
        <button
          onClick={toggleSteps}
          disabled={steps.length === 0}
          className={`mt-0.5 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-pill text-2xs font-bold uppercase tracking-[0.12em] transition-colors ${
            steps.length === 0
              ? 'text-ink-300 bg-transparent cursor-default'
              : displayStepsOpen
              ? 'text-info-700 bg-info-50 border border-info-200'
              : 'text-ink-500 bg-white/60 border border-ink-200/60 hover:text-ink-900 hover:bg-white'
          }`}
          aria-label={displayStepsOpen ? 'Hide steps' : 'Show steps'}
          aria-expanded={displayStepsOpen}
          title={steps.length === 0 ? 'No steps' : `${logicalStepCount} authored steps`}
        >
          {displayStepsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {logicalStepCount}
        </button>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-900 leading-snug">
            {tc.caseLabel && (
              <span className="inline-flex items-center mr-2 px-1.5 py-0.5 rounded-md bg-ink-100 text-ink-600 border border-ink-200 text-2xs font-bold tabular-nums align-middle whitespace-nowrap">
                {tc.caseLabel}
              </span>
            )}
            {tc.name}
          </div>
          {validationSummary.count > 0 && (
            validationSummary.details.length > 0 ? (
              <details className="group/validations mt-1.5 text-xs text-ink-500">
                <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-md text-ink-600 outline-none hover:text-ink-900 focus-visible:ring-2 focus-visible:ring-info-500 focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                  <span className="font-semibold">{validationSummary.label}</span>
                  <span className="text-info-700 group-open/validations:hidden">View details</span>
                  <span className="hidden text-info-700 group-open/validations:inline">Hide details</span>
                </summary>
                <ul className="mt-2 space-y-1 border-l border-ink-200 pl-3 leading-relaxed">
                  {validationSummary.details.map((detail, detailIndex) => (
                    <li key={`${detailIndex}-${detail.slice(0, 32)}`}>{detail}</li>
                  ))}
                  {validationSummary.remainingCount > 0 && (
                    <li className="font-medium text-ink-600">
                      and {validationSummary.remainingCount} more validation{validationSummary.remainingCount === 1 ? '' : 's'}
                    </li>
                  )}
                </ul>
              </details>
            ) : (
              <p className="mt-1.5 text-xs font-semibold text-ink-600">{validationSummary.label}</p>
            )
          )}
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-semibold border backdrop-blur-sm ${sm.cls}`}
            >
              {sm.icon && <sm.icon className="w-3 h-3" aria-hidden="true" />}
              {statusLabel}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-2xs font-medium bg-white/60 text-ink-700 border border-ink-200/60 backdrop-blur-sm">
              {typeLabel}
            </span>
            {bindingBadge && (
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-semibold border backdrop-blur-sm ${bindingBadge.className}`}
                title={bindingBadge.detail || bindingBadge.label}
              >
                {bindingBadge.label}
              </span>
            )}
            {readinessBadge && (
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-pill text-2xs font-semibold border backdrop-blur-sm"
                style={readinessBadge.style}
                title={`Compiler: ${readinessBadge.label} — ${readinessBadge.detail}`}
              >
                {readinessBadge.label}
              </span>
            )}
            {improved && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-semibold bg-accent-50/80 text-accent-700 border border-accent-200/70 backdrop-blur-sm"
                title={improvedTitle}
              >
                <Sparkles className="w-3 h-3" aria-hidden="true" />
                {improvedLabel}
              </span>
            )}
            {operation?.status === 'done' && !improved && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-semibold bg-accent-50/80 text-accent-700 border border-accent-200/70 backdrop-blur-sm"
                title="This case was refined in this session"
              >
                <Sparkles className="w-3 h-3" aria-hidden="true" />
                Refined
              </span>
            )}
            {operation?.status === 'error' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-semibold bg-danger-50/80 text-danger-700 border border-danger-200/70 backdrop-blur-sm">
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                Refine failed
              </span>
            )}
            {steps.length > 0 && (
              <span className="text-2xs text-ink-500 tabular-nums">
                {logicalStepCount} step{logicalStepCount === 1 ? '' : 's'}
              </span>
            )}
            <span className="text-2xs text-ink-300">·</span>
            <span className="text-2xs text-ink-500 tabular-nums" title="AI confidence in this test case">
              <span className="font-semibold text-ink-700">{tc.confidence}%</span> confidence
            </span>
            {tc.latestResult?.durationMs != null && (
              <>
                <span className="text-2xs text-ink-300">·</span>
                <span className="text-2xs text-ink-500 tabular-nums">
                  {(tc.latestResult.durationMs / 1000).toFixed(1)}s
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 shrink-0 opacity-0 blur-[1px] translate-y-1 pointer-events-none transition-all duration-200 group-hover/case:pointer-events-auto group-hover/case:translate-y-0 group-hover/case:opacity-100 group-hover/case:blur-0 group-focus-within/case:pointer-events-auto group-focus-within/case:translate-y-0 group-focus-within/case:opacity-100 group-focus-within/case:blur-0 sm:ml-auto">
          <button
            type="button"
            onClick={onRefine}
            disabled={refining}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-pill text-xs font-semibold text-accent-700 bg-white/60 backdrop-blur-sm border border-accent-200/60 hover:bg-accent-50/80 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
            title="Tell QAAI how to improve this test case's steps, data use, or assertions"
          >
            {refining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
            {refining ? 'Refining' : 'Improve'}
          </button>
          {tc.canRestorePrevious && (
            <button
              type="button"
              onClick={onRestore}
              disabled={refining}
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-pill text-xs font-semibold text-info-700 bg-white/60 backdrop-blur-sm border border-info-200/70 hover:bg-info-50/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:shadow-ring"
              title="Restore this case to the version before the last AI improvement"
            >
              <Undo2 className="w-3.5 h-3.5" />
              Restore
            </button>
          )}
          {tc.status === 'pending' && (
            <>
              <button
                onClick={onApprove}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-pill text-xs font-semibold text-success-700 bg-white/60 backdrop-blur-sm border border-success-200/60 hover:bg-success-50/80 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
              >
                <Check className="w-3.5 h-3.5" />
                Approve
              </button>
              <button
                onClick={onReject}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-pill text-xs font-semibold text-ink-500 hover:text-danger-700 hover:bg-danger-50/60 backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:shadow-ring"
              >
                <X className="w-3.5 h-3.5" />
                Reject
              </button>
            </>
          )}
          {tc.status === 'approved' && (
            <>
              <span className="inline-flex items-center gap-1 px-2.5 h-8 rounded-pill text-2xs font-bold uppercase tracking-wider text-success-700 bg-success-50/70 border border-success-200/60 backdrop-blur-sm">
                <Check className="w-3 h-3" />
                Approved
              </span>
              {/* Cherry-pick toggle. A case can be added to a smoke set so the
                  user can run a few targeted cases without launching the full
                  Execute Approved suite — useful for retesting a fix without
                  burning the whole API budget. State lives at the parent
                  TestCases level and persists to localStorage. */}
              {typeof onToggleSmoke === 'function' && (
                <button
                  type="button"
                  onClick={onToggleSmoke}
                  aria-pressed={!!smokeSelected}
                  title={smokeSelected ? 'Remove from smoke set' : 'Add to smoke set'}
                  className={`inline-flex items-center gap-1 h-8 px-2.5 rounded-pill text-2xs font-bold uppercase tracking-wider transition-colors backdrop-blur-sm ${
                    smokeSelected
                      ? 'text-info-700 bg-info-50 border border-info-200'
                      : 'text-ink-500 bg-white/60 border border-ink-200/60 hover:bg-info-50/60 hover:text-info-700 hover:border-info-200'
                  }`}
                >
                  <Target className="w-3 h-3" />
                  {smokeSelected ? 'In smoke' : 'Smoke'}
                </button>
              )}
            </>
          )}
          {tc.status === 'rejected' && (
            <span className="inline-flex items-center gap-1 px-2.5 h-8 rounded-pill text-2xs font-bold uppercase tracking-wider text-ink-600 bg-ink-100/70 border border-ink-200/60 backdrop-blur-sm">
              Rejected
            </span>
          )}
          {tc.status === 'running' && (
            <span className="inline-flex items-center gap-1 px-2.5 h-8 rounded-pill text-2xs font-bold uppercase tracking-wider text-info-700 bg-info-50/70 border border-info-200/60 backdrop-blur-sm">
              <Loader2 className="w-3 h-3 animate-spin" />
              Running
            </span>
          )}
        </div>
        </div>
      </div>

      {/* Steps expansion */}
      <AnimatePresence initial={false}>
        {displayStepsOpen && steps.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden [overflow-anchor:none]"
          >
            <StepsPanel
              steps={steps}
              stepStatuses={stepStatuses}
              running={tc.status === 'running'}
              onAddStep={onAddStep}
              onSaveStep={onSaveStep}
              onRemoveStep={onRemoveStep}
              onReorderSteps={onReorderSteps}
              onUndoStep={onUndoStep}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

// STEP_BADGE — visual mapping for the per-step live verdict (Bug B fix).
// `null` (no event seen yet) renders the original numbered chip; an active
// status renders an icon-coded chip + tinted border to make the verdict
// instantly readable while a run is in flight or after it completes.
export function buildStepEditorDraft(group) {
  const step = group?.steps?.[0] || group || {};
  const action = step.action || step.type || '';
  const target = step.target || step.element || '';
  const value = step.value ?? '';
  const validation = step.validation
    || step.verify
    || step.expected
    || step.operationCheck?.expected
    || '';
  const fallbackInstruction = [
    action,
    target ? `${/^(verify|assert)/i.test(action) ? '' : 'on '}${target}`.trim() : '',
    value !== '' && value != null ? `with ${String(value)}` : '',
    validation ? `and verify ${validation}` : '',
  ].filter(Boolean).join(' ');
  return {
    instruction: group?.authoredText || step.authoredText || step.text || fallbackInstruction || 'Complete this step.',
    action,
    target,
    value: value == null ? '' : String(value),
    validation: typeof validation === 'string' ? validation : JSON.stringify(validation),
    condition: typeof step.condition === 'string'
      ? step.condition
      : step.condition?.predicate || step.condition?.text || step.condition?.description || '',
  };
}

function StepEditForm({ draft, onChange, onCancel, onSave, saving, mode = 'edit' }) {
  const update = (field) => (event) => onChange({ ...draft, [field]: event.target.value });
  const actionDef = getActionDef(draft.action);
  const knownActionValues = useMemo(() => {
    const values = new Set();
    Object.values(ACTION_DROPDOWN_GROUPS).forEach((group) => {
      group.forEach((item) => values.add(item.value));
    });
    return values;
  }, []);
  const isCustomAction = draft.action && !knownActionValues.has(draft.action);

  const valuePlaceholder = actionDef?.valueLabel || (draft.action === 'Navigate' ? 'https://app.example.com/...' : '{{customer_email}}');
  const targetPlaceholder = actionDef?.targetRequired
    ? 'Target element (required)'
    : (actionDef && actionDef.fields && actionDef.fields.length === 0 ? 'Not required for this action' : 'Target element (e.g. Email field)');

  return (
    <form
      className="rounded-xl border border-accent-200/80 bg-accent-50/55 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label className="block">
        <span className="text-2xs font-bold uppercase tracking-[0.12em] text-ink-500">
          {mode === 'add' ? 'New step instruction' : 'Step instruction'}
        </span>
        <textarea
          value={draft.instruction}
          onChange={update('instruction')}
          autoFocus
          rows={3}
          className="mt-1.5 w-full resize-y rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm leading-relaxed text-ink-900 outline-none transition focus:border-accent-300 focus:shadow-ring"
          placeholder="Write the step naturally. Example: Enter the customer email and verify it is accepted."
          aria-label={mode === 'add' ? 'New step instruction' : 'Edit step instruction'}
        />
      </label>

      <details className="mt-2 rounded-lg border border-ink-200/70 bg-white/70">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ink-700 outline-none focus-visible:shadow-ring">
          Optional interpreted fields
        </summary>
        <div className="grid gap-2 border-t border-ink-200/70 p-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Action</span>
            <select
              value={draft.action || 'Click'}
              onChange={update('action')}
              className="mt-1 h-9 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-xs font-medium text-ink-900 outline-none transition focus:border-accent-300 focus:shadow-ring"
            >
              {isCustomAction && (
                <option value={draft.action}>
                  {draft.action} (Custom)
                </option>
              )}
              {Object.entries(ACTION_DROPDOWN_GROUPS).map(([category, actions]) => (
                <optgroup key={category} label={category}>
                  {actions.map((act) => (
                    <option key={act.value} value={act.value}>
                      {act.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Target</span>
            <input
              value={draft.target}
              onChange={update('target')}
              placeholder={targetPlaceholder}
              className="mt-1 h-9 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900 outline-none transition focus:border-accent-300 focus:shadow-ring"
            />
          </label>

          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-500">
              {actionDef?.valueLabel || 'Value or data token'}
            </span>
            <input
              value={draft.value}
              onChange={update('value')}
              placeholder={valuePlaceholder}
              className="mt-1 h-9 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900 outline-none transition focus:border-accent-300 focus:shadow-ring"
            />
          </label>

          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Validation</span>
            <input
              value={draft.validation}
              onChange={update('validation')}
              placeholder="Email value is accepted"
              className="mt-1 h-9 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900 outline-none transition focus:border-accent-300 focus:shadow-ring"
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Condition</span>
            <input
              value={draft.condition}
              onChange={update('condition')}
              placeholder="When the field is available"
              className="mt-1 h-9 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900 outline-none transition focus:border-accent-300 focus:shadow-ring"
            />
          </label>
        </div>
      </details>

      <p className="mt-2 text-xs leading-relaxed text-info-700">
        QAAI saves your exact instruction and can refine the interpretation during execution. Wording uncertainty does not block saving.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex min-h-9 items-center rounded-pill border border-ink-200 bg-white px-3 text-xs font-semibold text-ink-700 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !draft.instruction.trim()}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-accent-600 px-3 text-xs font-semibold text-white transition hover:bg-accent-700 focus-visible:outline-none focus-visible:shadow-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
          {mode === 'add' ? 'Add step' : 'Save step'}
        </button>
      </div>
    </form>
  );
}

function StepActionButtons({
  label,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  busy,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={menuRef} aria-label={`Actions for ${label}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={busy}
        className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border border-ink-200/80 bg-white/90 text-ink-600 shadow-2xs transition-all duration-150 hover:bg-ink-100/70 hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-ring disabled:cursor-not-allowed disabled:opacity-40 ${
          open ? 'opacity-100 ring-2 ring-accent-400/50' : 'opacity-0 group-hover/step:opacity-100 group-focus-within/step:opacity-100'
        }`}
        aria-label={`Open options for ${label}`}
        aria-expanded={open}
        title="More options"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-ink-500" /> : <MoreVertical className="h-4 w-4" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full z-40 mt-1.5 w-44 rounded-xl border border-ink-200/90 bg-white p-1.5 shadow-xl shadow-ink-900/10 backdrop-blur-xs"
          >
            <div className="space-y-0.5" role="menu">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onMoveUp?.();
                }}
                disabled={busy || !canMoveUp}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-ink-700 transition hover:bg-ink-100/70 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
                role="menuitem"
              >
                <ArrowUp className="h-3.5 w-3.5 text-ink-500" />
                <span>Move up</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onMoveDown?.();
                }}
                disabled={busy || !canMoveDown}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-ink-700 transition hover:bg-ink-100/70 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
                role="menuitem"
              >
                <ArrowDown className="h-3.5 w-3.5 text-ink-500" />
                <span>Move down</span>
              </button>

              <div className="my-1 border-t border-ink-100" />

              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onEdit?.();
                }}
                disabled={busy}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-accent-700 transition hover:bg-accent-50 hover:text-accent-900 disabled:cursor-not-allowed disabled:opacity-40"
                role="menuitem"
              >
                <Pencil className="h-3.5 w-3.5 text-accent-600" />
                <span>Edit step</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onRemove?.();
                }}
                disabled={busy}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-danger-700 transition hover:bg-danger-50 hover:text-danger-900 disabled:cursor-not-allowed disabled:opacity-40"
                role="menuitem"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger-600" />
                <span>Delete step</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function StepsPanel({
  steps,
  stepStatuses,
  floating = false,
  running = false,
  onAddStep,
  onSaveStep,
  onRemoveStep,
  onReorderSteps,
  onUndoStep,
}) {
  const groups = groupLogicalSteps(steps);
  const [editor, setEditor] = useState(null);
  const [busyStepId, setBusyStepId] = useState(null);
  const [undoState, setUndoState] = useState(null);
  const [mutationError, setMutationError] = useState('');

  const saveEditor = async () => {
    if (!editor?.draft?.instruction?.trim()) return;
    const operationId = editor.stepId || 'new';
    setBusyStepId(operationId);
    setMutationError('');
    try {
      let result;
      if (editor.mode === 'add') {
        result = await onAddStep?.(editor.draft);
      } else {
        result = await onSaveStep?.(editor.stepId, editor.draft);
      }
      if (result !== null) setEditor(null);
    } catch (error) {
      setMutationError(error?.toUserMessage?.() || error?.message || 'The step could not be saved. Your text is still in the editor.');
    } finally {
      setBusyStepId(null);
    }
  };

  const removeStep = async (group) => {
    setBusyStepId(group.id);
    setMutationError('');
    try {
      const result = await onRemoveStep?.(
        group.id,
        group.authoredText || `Step ${group.logicalOrdinal}`,
      );
      if (result?.undoToken || result?.canUndo || result?.mutation?.undoAvailable) {
        setUndoState({
          stepId: group.id,
          undoToken: result.undoToken || result?.mutation?.undoToken || null,
          label: group.authoredText || `Step ${group.logicalOrdinal}`,
        });
      }
    } catch (error) {
      setMutationError(error?.toUserMessage?.() || error?.message || 'The step could not be removed.');
    } finally {
      setBusyStepId(null);
    }
  };

  const moveStep = async (index, delta) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= groups.length) return;
    const reordered = groups.map((group) => group.id);
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    setBusyStepId(groups[index].id);
    setMutationError('');
    try {
      await onReorderSteps?.(reordered);
    } catch (error) {
      setMutationError(error?.toUserMessage?.() || error?.message || 'The step order could not be saved.');
    } finally {
      setBusyStepId(null);
    }
  };

  const undoRemoval = async () => {
    if (!undoState) return;
    setBusyStepId(undoState.stepId);
    setMutationError('');
    try {
      await onUndoStep?.(undoState.stepId, undoState.undoToken);
      setUndoState(null);
    } catch (error) {
      setMutationError(error?.toUserMessage?.() || error?.message || 'The step could not be restored.');
    } finally {
      setBusyStepId(null);
    }
  };

  return (
    <div className={`${floating ? 'max-h-[min(52vh,520px)] overflow-y-auto overscroll-contain rounded-xl border border-white/60 bg-white/62' : 'ml-12 mr-5 mb-4 rounded-xl border border-white/60 bg-white/50'} backdrop-blur-sm overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 border-b border-white/60 bg-white/70 px-3 py-2">
        <span className="text-2xs font-bold uppercase tracking-wider text-ink-500">
          {groups.length} step{groups.length === 1 ? '' : 's'}
        </span>
        {onAddStep ? (
          <button
            type="button"
            onClick={() => setEditor({
              mode: 'add',
              stepId: null,
              draft: { instruction: '', action: '', target: '', value: '', validation: '', condition: '' },
            })}
            disabled={!!editor || !!busyStepId}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-accent-200 bg-white px-3 text-xs font-semibold text-accent-700 transition hover:bg-accent-50 focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add step
          </button>
        ) : null}
      </div>

      {running ? (
        <div className="border-b border-info-200 bg-info-50 px-3 py-2 text-xs leading-relaxed text-info-800">
          Edits are saved for the next execution. The active run continues with its original step snapshot.
        </div>
      ) : null}

      {mutationError ? (
        <div className="flex items-start justify-between gap-3 border-b border-danger-200 bg-danger-50 px-3 py-2 text-xs leading-relaxed text-danger-800" role="alert">
          <span>{mutationError}</span>
          <button
            type="button"
            onClick={() => setMutationError('')}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-danger-700 transition hover:bg-danger-100 focus-visible:outline-none focus-visible:shadow-ring"
            aria-label="Dismiss step error"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {undoState ? (
        <div className="flex items-center justify-between gap-3 border-b border-info-200 bg-info-50 px-3 py-2 text-xs text-info-800">
          <span className="min-w-0 truncate">Step removed from future executions.</span>
          <button
            type="button"
            onClick={undoRemoval}
            disabled={busyStepId === undoState.stepId}
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-pill border border-info-200 bg-white px-3 font-semibold text-info-700 transition hover:bg-info-100 focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-50"
          >
            {busyStepId === undoState.stepId ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />}
            Undo
          </button>
        </div>
      ) : null}

      {editor?.mode === 'add' ? (
        <div className="border-b border-white/60 p-3">
          <StepEditForm
            draft={editor.draft}
            onChange={(draft) => setEditor((current) => ({ ...current, draft }))}
            onCancel={() => setEditor(null)}
            onSave={saveEditor}
            saving={busyStepId === 'new'}
            mode="add"
          />
        </div>
      ) : null}

      <ol className="divide-y divide-white/50">
        {groups.map((group, groupIndex) => {
          const atomic = group.steps;
          const isEditing = editor?.mode === 'edit' && editor.stepId === group.id;
          const label = `Step ${group.logicalOrdinal}`;
          return (
            <li key={group.id} className="group/step px-3 py-2.5 transition hover:bg-white/60">
              {isEditing ? (
                <StepEditForm
                  draft={editor.draft}
                  onChange={(draft) => setEditor((current) => ({ ...current, draft }))}
                  onCancel={() => setEditor(null)}
                  onSave={saveEditor}
                  saving={busyStepId === group.id}
                />
              ) : (
                <>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      {atomic.length > 1 ? (
                        <div className="flex gap-3 rounded-lg bg-info-50/45 px-2 py-2">
                          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-info-100 text-2xs font-bold tabular-nums text-info-700">
                            {group.logicalOrdinal}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold leading-relaxed text-ink-900">{group.authoredText || label}</p>
                            <p className="mt-0.5 text-2xs text-ink-500">
                              {atomic.length} execution actions
                            </p>
                          </div>
                        </div>
                      ) : (
                        <StepRow
                          step={atomic[0]}
                          index={group.logicalOrdinal}
                          status={stepStatuses?.[atomic[0]?._sourceIndex]?.status || null}
                          error={stepStatuses?.[atomic[0]?._sourceIndex]?.error || null}
                          operationCheck={stepStatuses?.[atomic[0]?._sourceIndex]?.operationCheck || null}
                          assertion={stepStatuses?.[atomic[0]?._sourceIndex]?.assertion || null}
                        />
                      )}
                    </div>
                    <StepActionButtons
                      label={label}
                      onEdit={() => setEditor({ mode: 'edit', stepId: group.id, draft: buildStepEditorDraft(group) })}
                      onRemove={() => removeStep(group)}
                      onMoveUp={() => moveStep(groupIndex, -1)}
                      onMoveDown={() => moveStep(groupIndex, 1)}
                      canMoveUp={groupIndex > 0}
                      canMoveDown={groupIndex < groups.length - 1}
                      busy={busyStepId === group.id}
                    />
                  </div>

                  {atomic.length > 1 ? (
                    <details className="ml-9 mt-2 rounded-lg border border-ink-200/70 bg-white/55">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ink-600 outline-none focus-visible:shadow-ring">
                        View execution details
                      </summary>
                      <div className="divide-y divide-ink-100 border-t border-ink-200/70">
                        {atomic.map((step, atomicIndex) => {
                          const sourceIndex = step._sourceIndex;
                          return (
                            <StepRow
                              key={`${group.id}:${step.id || step.stepId || sourceIndex}`}
                              step={step}
                              index={`${group.logicalOrdinal}.${atomicIndex + 1}`}
                              status={stepStatuses?.[sourceIndex]?.status || null}
                              error={stepStatuses?.[sourceIndex]?.error || null}
                              operationCheck={stepStatuses?.[sourceIndex]?.operationCheck || null}
                              assertion={stepStatuses?.[sourceIndex]?.assertion || null}
                            />
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const STEP_BADGE = {
  running: { ring: 'ring-info-300/70',    chip: 'bg-info-100 text-info-700',       icon: Loader2,        spin: true,  label: 'Running' },
  pass:    { ring: 'ring-success-300/70', chip: 'bg-success-100 text-success-700', icon: CheckCircle2,                 label: 'Passed' },
  fail:    { ring: 'ring-danger-300/70',  chip: 'bg-danger-100 text-danger-700',   icon: XCircle,                      label: 'Failed' },
  blocked: { ring: 'ring-warn-300/70',    chip: 'bg-warn-100 text-warn-700',       icon: Circle,                       label: 'Blocked' },
  skipped: { ring: 'ring-ink-200/70',     chip: 'bg-ink-100 text-ink-500',         icon: Minus,                        label: 'Skipped' },
};

function StepRow({ step, index, status, error, operationCheck, assertion }) {
  const badge = status ? STEP_BADGE[status] : null;
  const Icon = badge?.icon;
  const actionName = step.action || step.type || 'Step';
  const displayAction = /^Assert/i.test(actionName) ? 'Verify' : actionName;
  const selection = step.selectionCriteria && typeof step.selectionCriteria === 'object'
    ? step.selectionCriteria
    : null;
  const selectionValue = selection && (
    selection.expectedText || selection.text || selection.value || selection.predicate || selection.ref
  );
  const displayValue = /^Select$/i.test(actionName)
    ? (selectionValue || step.value)
    : step.value;
  const conditionText = step.condition && typeof step.condition === 'object'
    ? (step.condition.predicate || step.condition.text || step.condition.description)
    : step.condition;
  const plannedOperationCheck = step.operationCheck || step.syncState || null;
  const check = operationCheck || plannedOperationCheck;
  const checkText = check && typeof check === 'object' ? check.expected : null;
  const isVerification = step.verificationPoint || step.stepKind === 'verification' || /^Assert/i.test(actionName) || !!step.verify;
  const assertionText = assertion?.expected || (isVerification ? (step.expected || step.text) : null);
  const legacyExpectedText = !checkText && !assertionText ? step.expected : null;
  return (
    <div className={`grid min-w-0 grid-cols-[32px_1fr] gap-2 rounded-lg px-2 py-2 ${badge ? `ring-1 ring-inset ${badge.ring}` : ''}`}>
      <div className="flex items-start">
        {badge ? (
          <span
            className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${badge.chip}`}
            title={badge.label}
            aria-label={`Step ${step.order || index} — ${badge.label}`}
          >
            <Icon className={`w-3.5 h-3.5 ${badge.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
          </span>
        ) : (
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-info-100/80 text-info-700 text-2xs font-bold tabular-nums">
            {step.order || index}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold text-ink-900">{displayAction}</span>
          {(step.element || step.target) && (
            <span className="text-xs text-ink-600">
              on <span className="text-ink-700 bg-white/70 px-1 rounded">{step.element || step.target}</span>
            </span>
          )}
          {step.locator_hint && (
            <span className="text-2xs text-ink-500" title="Selector hint — used for disambiguation, not passed to MCP">
              <span className="font-mono bg-white/60 px-1 rounded">{step.locator_hint}</span>
            </span>
          )}
          {badge && (
            <span className={`text-2xs uppercase tracking-wider font-bold ${badge.chip} px-1.5 py-0.5 rounded`}>
              {badge.label}
            </span>
          )}
        </div>
        {displayValue !== undefined && displayValue !== null && displayValue !== '' && (
          <div className="text-xs text-ink-600 mt-0.5">
            <span className="text-ink-400">value: </span>
            <span className="font-mono text-ink-800 bg-white/70 px-1 rounded">"{String(displayValue)}"</span>
          </div>
        )}
        {conditionText && (
          <div className="text-xs text-ink-600 mt-0.5">
            <span className="text-ink-400">when: </span>
            {conditionText}
          </div>
        )}
        {(checkText || legacyExpectedText) && (
          <div className="text-xs text-success-700 mt-0.5">
            <span className="text-ink-400">check: </span>
            {checkText || legacyExpectedText}
          </div>
        )}
        {assertionText && (
          <div className="text-xs text-info-700 mt-0.5">
            <span className="text-ink-400">verify: </span>
            {assertionText}
          </div>
        )}
        {error && (status === 'fail' || status === 'blocked') && (
          <div className="text-xs text-danger-700 mt-1 leading-relaxed line-clamp-2">
            <span className="font-semibold">why:</span> {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchModal — glass command-palette. Cmd+K opens; backdrop blurs the page.
// ─────────────────────────────────────────────────────────────────────────────
function SearchModal({ scenarios, onClose, onPick }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const allCases = useMemo(() => {
    return scenarios.flatMap((s) =>
      s.cases.map((c) => ({
        scenarioId: s.id, scenarioName: s.name, module: s.module, priority: s.priority,
        id: c.id, name: c.name, assertions: c.assertions || '', type: c.type,
        confidence: c.confidence, status: c.status,
      })),
    );
  }, [scenarios]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allCases.slice(0, 12);
    return allCases.filter((c) =>
      c.name.toLowerCase().includes(needle) || c.assertions.toLowerCase().includes(needle),
    ).slice(0, 12);
  }, [allCases, q]);

  useEffect(() => { setActiveIdx(0); }, [results.length]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && results[activeIdx]) {
      e.preventDefault();
      const pick = results[activeIdx];
      onPick(pick.scenarioId, pick.id);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-ink-900/30 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Search test cases"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-2xl glass overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/60">
          <Search className="w-4 h-4 text-ink-500" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search cases by name or assertions…"
            className="flex-1 text-sm text-ink-900 placeholder:text-ink-400 outline-none bg-transparent"
            aria-label="Search query"
          />
          <kbd className="text-2xs font-mono text-ink-500 border border-ink-200/60 rounded px-1 py-0.5 bg-white/60">
            Esc
          </kbd>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-ink-400 hover:text-ink-700 rounded hover:bg-white/60 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto" role="listbox">
          {results.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-ink-500">
              <FileText className="w-6 h-6 mx-auto mb-2 text-ink-300" />
              No matches. Try a different query.
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                role="option"
                aria-selected={i === activeIdx}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => onPick(r.scenarioId, r.id)}
                className={`w-full text-left px-4 py-3 border-b border-white/40 last:border-b-0 transition-colors ${
                  i === activeIdx ? 'bg-accent-50/60' : 'hover:bg-white/40'
                }`}
              >
                <div className="flex items-center gap-2 mb-1 text-2xs uppercase tracking-[0.14em] text-ink-500 font-semibold">
                  <span className={`${TONE_TEXT[PRIORITY_TONE[r.priority] || 'info']} font-bold`}>{r.priority}</span>
                  <span className="text-ink-300">·</span>
                  <span>{r.module}</span>
                  <span className="ml-auto text-ink-400 normal-case tracking-normal font-normal truncate max-w-[40%]" title={r.scenarioName}>
                    {r.scenarioName}
                  </span>
                </div>
                <div className="text-sm font-semibold text-ink-900 leading-snug">{r.name}</div>
                {r.assertions && (
                  <p className="text-xs text-ink-500 mt-0.5 line-clamp-1">{r.assertions}</p>
                )}
              </button>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-white/60 flex items-center gap-3 text-2xs text-ink-500 bg-white/30">
          <span>
            <kbd className="font-mono border border-ink-200/60 rounded px-1 bg-white/60">↑</kbd>{' '}
            <kbd className="font-mono border border-ink-200/60 rounded px-1 bg-white/60">↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono border border-ink-200/60 rounded px-1 bg-white/60">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono border border-ink-200/60 rounded px-1 bg-white/60">Esc</kbd> close
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TestCases — the page
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// AutomationManualTabs — sits above the Execution Strip / Manual list. Two
// tab pills with case-count badges + a "manual completed" sub-count under
// the Manual pill so the user can see at a glance how many of their manual
// cases the tester has ticked off.
// ─────────────────────────────────────────────────────────────────────────────
function AutomationManualTabs({ current, onChange, automationCount, manualCount, manualCompleted }) {
  const tabs = [
    {
      key: 'automation',
      label: 'Automation',
      icon: Bot,
      total: automationCount,
      sub: `${automationCount} case${automationCount === 1 ? '' : 's'}`,
    },
    {
      key: 'manual',
      label: 'Manual',
      icon: Hand,
      total: manualCount,
      sub: manualCount === 0
        ? 'No manual cases this run'
        : `${manualCompleted}/${manualCount} completed`,
    },
  ];
  return (
    <div role="tablist" aria-label="Test cases" className="glass-soft rounded-2xl p-1.5 flex items-stretch gap-1.5">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = current === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all ${
              active
                ? 'bg-white shadow-card border border-ink-200 text-ink-900'
                : 'bg-transparent text-ink-600 hover:bg-white/60 hover:text-ink-800'
            }`}
          >
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
              active
                ? (tab.key === 'manual' ? 'bg-warn-100 text-warn-700' : 'bg-info-100 text-info-700')
                : 'bg-ink-100 text-ink-500'
            }`}>
              <Icon className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold tracking-tight">{tab.label}</span>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                  active
                    ? (tab.key === 'manual' ? 'bg-warn-100 text-warn-700' : 'bg-info-100 text-info-700')
                    : 'bg-ink-100 text-ink-600'
                }`}>{tab.total}</span>
              </div>
              <div className="text-[11px] text-ink-500 mt-0.5 truncate">{tab.sub}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ManualPanel — the Manual tab body. Renders the manual cases grouped by
// scenario, each with a "Why manual?" chip, lazy-loaded AI guide disclosure,
// Mark-complete button, Reclassify (override), and Markdown export.
// ─────────────────────────────────────────────────────────────────────────────
function ManualPanel({ manualScenarios, loading, onReload }) {
  const { current } = useProject();
  const toast = useToast();
  const [guideById, setGuideById] = useState({}); // tcId -> { state: 'idle'|'loading'|'ready', text? }
  const [openGuideIds, setOpenGuideIds] = useState(() => new Set());

  const totalCases = useMemo(() => manualScenarios.reduce((a, s) => a + s.cases.length, 0), [manualScenarios]);
  const completed = useMemo(() => manualScenarios.reduce((a, s) => a + s.cases.filter((c) => c.manualCompletedAt).length, 0), [manualScenarios]);

  const loadGuide = useCallback(async (tc, { regen = false } = {}) => {
    if (!current?.id) return null;
    setGuideById((prev) => ({ ...prev, [tc.id]: { state: 'loading', text: prev[tc.id]?.text || null } }));
    try {
      const url = `/projects/${current.id}/test-cases/${tc.id}/manual-guide${regen ? '?regen=1' : ''}`;
      const res = await api.post(url, {});
      setGuideById((prev) => ({ ...prev, [tc.id]: { state: 'ready', text: res.guide } }));
      if (regen) toast.success('Guide regenerated.');
      // Return the text directly so callers (exportMarkdown) can use it
      // without reading stale state — setState is async and the closure would
      // still see the old guideById on the very next line after await.
      return res.guide || null;
    } catch (err) {
      setGuideById((prev) => ({ ...prev, [tc.id]: { state: 'idle', text: null } }));
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Guide generation failed' });
      return null;
    }
  }, [current?.id, toast]);

  const toggleGuide = useCallback((tc) => {
    setOpenGuideIds((prev) => {
      const next = new Set(prev);
      if (next.has(tc.id)) next.delete(tc.id);
      else next.add(tc.id);
      return next;
    });
    // Auto-fetch on first open if we don't have the text yet AND the case
    // doesn't have a cached guide on the server already (the server returns
    // cached guide on first call too, so this is just to avoid a round-trip
    // when we already pulled it in this session).
    if (!openGuideIds.has(tc.id)) {
      const entry = guideById[tc.id];
      if (!entry || (!entry.text && entry.state !== 'loading')) loadGuide(tc);
    }
  }, [openGuideIds, guideById, loadGuide]);

  const markComplete = useCallback(async (tc) => {
    if (!current?.id) return;
    try {
      const undo = !!tc.manualCompletedAt;
      await api.post(`/projects/${current.id}/test-cases/${tc.id}/manual-complete`, { undo });
      toast.success(undo ? 'Marked incomplete.' : 'Marked complete.');
      await onReload();
    } catch (err) {
      toast.error(err.message);
    }
  }, [current?.id, onReload, toast]);

  const reclassify = useCallback(async (tc) => {
    if (!current?.id) return;
    if (!window.__qaaiConfirmReclassify) {
      // tiny inline confirm — page-level useConfirm would require lifting,
      // so we accept window.confirm here.
    }
    try {
      await api.post(`/projects/${current.id}/test-cases/${tc.id}/reclassify`, { automatability: 'automatable' });
      toast.success('Reclassified as automatable. The case now appears on the Automation tab.');
      await onReload();
    } catch (err) {
      toast.error(err.message);
    }
  }, [current?.id, onReload, toast]);

  const exportMarkdown = useCallback(async (tc) => {
    let guideText = guideById[tc.id]?.text;
    if (!guideText) {
      // Use the returned text directly — reading guideById[tc.id]?.text after
      // the await would return stale state because setState is async.
      guideText = await loadGuide(tc);
    }
    const md = [
      `# ${tc.name}`,
      '',
      tc.module ? `**Module:** ${tc.module}` : null,
      tc.automatabilityReason ? `**Why manual:** ${tc.automatabilityReason}` : null,
      tc.assignedTo ? `**Assigned to:** ${tc.assignedTo}` : null,
      '',
      guideText || '_Guide not yet generated. Open the case and click "Generate guide" first._',
    ].filter((line) => line !== null).join('\n');
    try {
      await navigator.clipboard.writeText(md);
      toast.success('Copied Markdown to clipboard.');
    } catch (_) {
      // Clipboard write blocked — fall back to download.
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tc.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Downloaded Markdown.');
    }
  }, [guideById, loadGuide, toast]);

  if (loading) {
    return <Skeleton className="h-40 rounded-2xl" />;
  }
  if (totalCases === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="glass p-10 flex flex-col items-center text-center"
      >
        <div className="w-14 h-14 rounded-2xl bg-warn-100/70 border border-warn-200/60 inline-flex items-center justify-center mb-4">
          <Hand className="w-6 h-6 text-warn-700" />
        </div>
        <h2 className="font-display text-3xl text-ink-900 tracking-tight">No manual cases.</h2>
        <p className="text-sm text-ink-600 mt-3 max-w-md leading-relaxed">
          The Architect didn't flag any cases for manual testing. If you have a case that genuinely can't be automated
          (compliance approvals, hardware-dependent flows, visual-fidelity reviews), open it on the Automation tab and choose
          <strong className="text-ink-800"> Reclassify as manual</strong>.
        </p>
      </motion.div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-soft rounded-xl px-4 py-3 flex items-center gap-3">
        <ClipboardCheck className="w-4 h-4 text-warn-700 shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink-900">
            {completed} of {totalCases} manual cases completed
          </p>
          <p className="text-xs text-ink-600 mt-0.5">
            Manual cases are completed by a human tester — they don't drive Playwright. Mark each one complete after you verify.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {manualScenarios.map((s) => (
          <div key={s.id} className="glass rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-500">{s.module || 'misc'}</span>
              <span className="text-ink-300">·</span>
              <h3 className="text-sm font-semibold text-ink-900 truncate flex-1">{s.name}</h3>
              <span className="text-[11px] text-ink-500 shrink-0">
                {s.cases.length} case{s.cases.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="space-y-2">
              {s.cases.map((c) => (
                <ManualCaseRow
                  key={c.id}
                  testCase={c}
                  guideEntry={guideById[c.id]}
                  open={openGuideIds.has(c.id)}
                  onToggle={() => toggleGuide(c)}
                  onRegenerateGuide={() => loadGuide(c, { regen: true })}
                  onMarkComplete={() => markComplete(c)}
                  onReclassify={() => reclassify(c)}
                  onExport={() => exportMarkdown(c)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ManualCaseRow — single manual case. "Why manual?" chip, disclosed guide,
// Mark complete / Reclassify / Export controls.
// ─────────────────────────────────────────────────────────────────────────────
function ManualCaseRow({
  testCase: c,
  guideEntry,
  open,
  onToggle,
  onRegenerateGuide,
  onMarkComplete,
  onReclassify,
  onExport,
}) {
  const completed = !!c.manualCompletedAt;
  const guideLoading = guideEntry?.state === 'loading';
  const guideText = guideEntry?.text;
  return (
    <li className={`rounded-xl border ${completed ? 'bg-success-50/40 border-success-200' : 'bg-white border-ink-200'} px-4 py-3`}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onMarkComplete}
          aria-pressed={completed}
          title={completed ? 'Mark as incomplete' : 'Mark complete'}
          className={`shrink-0 w-6 h-6 rounded-md border flex items-center justify-center transition-colors ${
            completed
              ? 'bg-success-600 border-success-600 text-white hover:bg-success-700'
              : 'bg-white border-ink-300 text-transparent hover:border-ink-500'
          }`}
        >
          <Check className="w-4 h-4" aria-hidden="true" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-sm font-medium ${completed ? 'text-ink-500 line-through' : 'text-ink-900'} truncate`}>
              {c.name}
            </span>
            {c.automatabilityReason && (
              <span
                className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-warn-100 text-warn-700 border border-warn-200"
                title="Architect-recorded reason this case is manual"
              >
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                {c.automatabilityReason}
              </span>
            )}
            {completed && c.manualCompletedAt && (
              <span className="text-[11px] text-success-700">
                Completed {new Date(c.manualCompletedAt).toLocaleString()}
              </span>
            )}
          </div>
          {c.assertions && (
            <p className="text-xs text-ink-600 mt-1 line-clamp-2 leading-relaxed">{c.assertions}</p>
          )}

          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex items-center gap-1 text-xs font-medium text-info-700 hover:text-info-900 px-2 py-1 rounded-md hover:bg-info-50 transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
              {open ? 'Hide steps' : 'How to test'}
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
            <button
              type="button"
              onClick={onExport}
              className="inline-flex items-center gap-1 text-xs font-medium text-ink-700 hover:text-ink-900 px-2 py-1 rounded-md hover:bg-ink-100 transition-colors"
              title="Copy Markdown to clipboard"
            >
              <DownloadIcon className="w-3.5 h-3.5" aria-hidden="true" />
              Export Markdown
            </button>
            <button
              type="button"
              onClick={onReclassify}
              className="inline-flex items-center gap-1 text-xs font-medium text-ink-700 hover:text-ink-900 px-2 py-1 rounded-md hover:bg-ink-100 transition-colors"
              title="If automation IS possible after all, move it back to the Automation tab"
            >
              <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
              Reclassify as automatable
            </button>
          </div>

          {open && (
            <div className="mt-2 rounded-lg border border-ink-200 bg-ink-50/40 px-3 py-3">
              {guideLoading && !guideText && (
                <div className="flex items-center gap-2 text-xs text-ink-600">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Generating step-by-step guide with the AI…
                </div>
              )}
              {guideText && (
                <>
                  <div className="prose prose-sm prose-ink max-w-none text-sm text-ink-800 whitespace-pre-wrap leading-relaxed">
                    {guideText}
                  </div>
                  <div className="mt-3 flex items-center justify-end">
                    <button
                      type="button"
                      onClick={onRegenerateGuide}
                      disabled={guideLoading}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-500 hover:text-ink-800 px-2 py-1 rounded-md hover:bg-ink-100 transition-colors disabled:opacity-50"
                    >
                      {guideLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
                      Regenerate guide
                    </button>
                  </div>
                </>
              )}
              {!guideLoading && !guideText && (
                <div className="flex items-center gap-2 text-xs text-ink-600">
                  <AlertTriangle className="w-3.5 h-3.5 text-warn-600" />
                  Couldn't generate the guide. Tap "Regenerate" to retry.
                  <button
                    type="button"
                    onClick={onRegenerateGuide}
                    className="ml-2 text-info-700 hover:text-info-900 font-medium underline-offset-2 hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// Scenarios cache — keyed by projectId. Survives component unmounts
// (navigation away and back) so the page never flashes a skeleton during
// an active run. Populated on every successful load(); read only by the
// useState initializer on re-mount.
const _scenariosCache = {};

const _scenarioOperationStore = {
  byProject: new Map(),
  listeners: new Set(),
};
const EMPTY_OPERATION_SNAPSHOT = { scenarioOps: {}, caseOps: {} };

function emptyOperationSnapshot() {
  return EMPTY_OPERATION_SNAPSHOT;
}

function getOperationSnapshot(projectId) {
  if (!projectId) return emptyOperationSnapshot();
  return _scenarioOperationStore.byProject.get(projectId) || emptyOperationSnapshot();
}

function emitOperationSnapshot() {
  for (const fn of _scenarioOperationStore.listeners) fn();
}

function subscribeOperationSnapshot(fn) {
  _scenarioOperationStore.listeners.add(fn);
  return () => _scenarioOperationStore.listeners.delete(fn);
}

function patchOperationSnapshot(projectId, bucket, id, patch) {
  if (!projectId || !id) return;
  const cur = getOperationSnapshot(projectId);
  const next = {
    scenarioOps: cur.scenarioOps,
    caseOps: cur.caseOps,
    [bucket]: {
      ...cur[bucket],
      [id]: {
        ...(cur[bucket]?.[id] || {}),
        ...patch,
        updatedAt: Date.now(),
      },
    },
  };
  _scenarioOperationStore.byProject.set(projectId, next);
  emitOperationSnapshot();
}

function patchManyOperationSnapshots(projectId, bucket, entries) {
  if (!projectId || !entries?.length) return;
  const cur = getOperationSnapshot(projectId);
  const nextBucket = { ...cur[bucket] };
  const now = Date.now();
  for (const [id, patch] of entries) {
    if (!id) continue;
    nextBucket[id] = {
      ...(nextBucket[id] || {}),
      ...patch,
      updatedAt: now,
    };
  }
  _scenarioOperationStore.byProject.set(projectId, {
    scenarioOps: cur.scenarioOps,
    caseOps: cur.caseOps,
    [bucket]: nextBucket,
  });
  emitOperationSnapshot();
}

function clearOperationSnapshot(projectId) {
  if (!projectId) return;
  const cur = getOperationSnapshot(projectId);
  const hasRunning = [...Object.values(cur.scenarioOps), ...Object.values(cur.caseOps)]
    .some((op) => op?.status === 'running');
  if (hasRunning) return;
  _scenarioOperationStore.byProject.delete(projectId);
  emitOperationSnapshot();
}

function makeAuthoringOperationId(prefix, id) {
  const rand = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return `${prefix}:${id}:${rand}`;
}

function useScenarioOperations(projectId) {
  return useSyncExternalStore(
    subscribeOperationSnapshot,
    () => getOperationSnapshot(projectId),
    emptyOperationSnapshot,
  );
}

function stepLogicalIdentity(step, sourceIndex = 0) {
  return step?.logicalStepId
    || step?.id
    || step?.stepId
    || step?.caseContractStepId
    || step?.contractStepId
    || `legacy-step-${sourceIndex + 1}`;
}

export function mergeStepMutationResult(testCase, result, fallbackSteps) {
  const payload = result && typeof result === 'object' ? result : {};
  const returnedCase = payload.testCase || payload.case || payload.updatedTestCase || {};
  const returnedSteps = Array.isArray(returnedCase.steps)
    ? returnedCase.steps
    : Array.isArray(payload.steps)
      ? payload.steps
      : fallbackSteps;
  const nextSteps = Array.isArray(returnedSteps) ? returnedSteps : (Array.isArray(testCase?.steps) ? testCase.steps : []);
  const serverCount = returnedCase.logicalStepCount ?? payload.logicalStepCount ?? payload.counts?.logicalSteps;
  return {
    ...testCase,
    ...returnedCase,
    steps: nextSteps,
    logicalStepCount: serverCount != null && Number.isFinite(Number(serverCount))
      ? Number(serverCount)
      : groupLogicalSteps(nextSteps).length,
  };
}

export default function TestCases() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const justGenerated = searchParams.get('just') === 'generated';
  const moduleParam = searchParams.get('module') || null;

  const toast = useToast();
  const { current, currentSprintId, generations, currentGenerationId, refreshGenerations, switchGeneration, refresh: refreshProjects } = useProject();
  const executionGenerationId = currentGenerationId || generations.find((generation) => generation.isCurrent)?.id || null;
  const { running, subscribe, setRunning } = useRunStream();
  const { pipelineState } = usePipelineState();
  // Generation state is derived from THREE sources so the hero stays
  // accurate across page navigations and WS reconnects:
  //   1. Local `generating` (set immediately on click → instant feedback
  //      before the WS round-trip).
  //   2. Global phaseStatus.architect === 'running' (survives unmount, so
  //      navigating away from Test Cases and back doesn't lose the spinner
  //      — the user's exact complaint: "ongoing generation is vanishing
  //      when I switch pages").
  //   3. architectProgress.scenariosSoFar — the streaming counter that
  //      drives the percentage circle. Real, derived from depth-tracking
  //      the partial JSON, NOT a time-based estimate.
  const architectPhaseRunning = pipelineState?.phaseStatus?.architect === 'running';
  const architectProgress = pipelineState?.architectProgress || null;

  const [scenarios, setScenarios] = useState(() => _scenariosCache[current?.id] ?? []);
  const [loading, setLoading] = useState(true);
  // True once at least one run exists for this project. Drives the Run button
  // label: "Live execution run" on first-ever run; "Rerun All" thereafter.
  const [hasRuns, setHasRuns] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [guidanceTarget, setGuidanceTarget] = useState(null);
  const [guidanceSubmitting, setGuidanceSubmitting] = useState(false);
  // Re-opens the GenerateConfigCard over the existing list so the user can pick
  // a different mode/focus and generate a NEW generation (vs. the empty state).
  const [showNewBatch, setShowNewBatch] = useState(false);
  const [showAddScenario, setShowAddScenario] = useState(false);
  const [addScenarioSubmitting, setAddScenarioSubmitting] = useState(false);
  const [interpretationSubmitting, setInterpretationSubmitting] = useState(false);
  const [interpretationPreview, setInterpretationPreview] = useState(null);
  const [interpretationRefining, setInterpretationRefining] = useState(false);
  const [interpretationApproving, setInterpretationApproving] = useState(false);
  const [addScenarioPreview, setAddScenarioPreview] = useState(null);
  const [addScenarioPreviewRequest, setAddScenarioPreviewRequest] = useState(null);
  const [previewRefining, setPreviewRefining] = useState(false);
  const [previewApproving, setPreviewApproving] = useState(false);
  const [approving, setApproving] = useState(false);
  const approvingRef = useRef(false);
  const [executing, setExecuting] = useState(false);
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);
  const [triggerLoading, setTriggerLoading] = useState(false);
  const [triggerSaving, setTriggerSaving] = useState(false);
  const [triggerDraft, setTriggerDraft] = useState(DEFAULT_TRIGGER_CONFIG);
  const [authFixtures, setAuthFixtures] = useState([]);
  // Headless/headed toggle for the live Conductor's browser launch. null =
  // not loaded yet; the browser-context PUT is what actually takes effect
  // on the NEXT run (mcp.js reads project.contextHeadless at session boot).
  const [headlessMode, setHeadlessMode] = useState(null);
  const [headlessSaving, setHeadlessSaving] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const mainScrollRef = useRef(null);
  const [filter, setFilter] = useState('all');
  // Seed from ?status= so the Overview Passed/Failed KPI tiles drill in here
  // pre-filtered. Both the tile COUNT and this view derive from each case's
  // latestResult.status (cumulative latest-per-case), so count == list — that
  // fixes the "click Passed → empty/mismatched" bug where the tile used to
  // drill into a single run instead of the same cumulative set it counted.
  const [statusFilter, setStatusFilter] = useState(() => {
    const s = searchParams.get('status');
    return ['pass', 'fail', 'blocked', 'skipped', 'approved', 'pending', 'rejected'].includes(s) ? s : null;
  });
  const [confidenceMin, setConfidenceMin] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkIds, setBulkIds] = useState(() => new Set());
  // Smoke-picker: cherry-pick a subset of approved cases for a targeted
  // rerun. Distinct from bulkIds (which gates bulk approve/reject) — a user
  // can curate a smoke set across multiple review sessions and launch it
  // when ready, without having to run the full Execute approved suite. The
  // set persists to localStorage per project so a refresh or navigation
  // doesn't lose carefully-curated picks.
  const [smokeIds, setSmokeIds] = useState(() => new Set());
  const [runningSmoke, setRunningSmoke] = useState(false);
  const [regenScenarioId, setRegenScenarioId] = useState(null);
  const [deleteScenarioId, setDeleteScenarioId] = useState(null);
  const [hoverScenarioId, setHoverScenarioId] = useState(null);
  const { scenarioOps, caseOps } = useScenarioOperations(current?.id);
  const scenarioRefs = useRef(new Map());
  // Phase D — Automation / Manual tab split. Manual cases are completed by a
  // human tester and excluded from the Run CTA / Playwright path entirely.
  const [automationTab, setAutomationTab] = useState('automation'); // 'automation' | 'manual'

  useEffect(() => {
    if (!current?.id || !running) return undefined;
    let cancelled = false;
    const reconcile = () => {
      api.get(`/projects/${current.id}/agents/status`)
        .then((data) => {
          if (cancelled) return;
          if (!data?.running && !data?.cancelRequested) {
            setRunning(false);
          }
        })
        .catch(() => {});
    };
    const graceTimer = setTimeout(reconcile, 1000);
    const intervalId = setInterval(reconcile, 8000);
    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
      clearInterval(intervalId);
    };
  }, [current?.id, running, setRunning]);

  // Bug B: live per-step verdict map driven by step.* WS events from the
  // conductor. Shape: { [tcId]: { [stepIndex]: { status, error } } }. Seeded
  // from RunResult.stepResults on load() once the schema migration lands;
  // until then it lives only in-memory for the duration of the page session.
  const [stepStatusByTc, setStepStatusByTc] = useState({});

  // reqCount: null = not yet checked, 0 = no docs uploaded, N = has docs.
  // Controls whether we show the GenerateConfigCard or the "upload docs first" state.
  const [reqCount, setReqCount] = useState(null);

  // Hoisted alongside the state hooks so any useCallback defined below can
  // reference `confirm` without hitting the const TDZ (several callbacks below —
  // e.g. bulk delete — call confirm during render-time setup). The hook still
  // runs unconditionally on every render — order w.r.t. other hooks is preserved.
  const confirm = useConfirm();

  // Inline phase indicator — lazy initialisers seed from global pipelineState
  // so navigating away and back during generation doesn't blank the banner.
  // architectPhaseRunning (from pipelineState above) already keeps the "running"
  // pill correct; these locals fill the log line and drive the elapsed timer.
  const [activePhase, setActivePhase] = useState(() => {
    const s = pipelineState?.phaseStatus?.architect;
    return (s && s !== 'idle') ? 'architect' : null;
  });
  const [phaseLog, setPhaseLog] = useState(() => {
    const logs = pipelineState?.logs?.architect || [];
    return logs.length > 0 ? logs[logs.length - 1].message : '';
  });
  const [phaseStatus, setPhaseStatus] = useState(() => {
    const s = pipelineState?.phaseStatus?.architect;
    return (s && s !== 'idle') ? s : 'idle';
  });
  const [phaseElapsed, setPhaseElapsed] = useState(0);
  const phaseStartedAtRef = useRef(0);

  const load = useCallback(async () => {
    if (!current) { setLoading(false); return; }
    setLoading(true);
    let loaded = false;
    try {
      // Versioning — scope to the active generation so selecting a past
      // generation shows that batch's scenarios.
      const genQs = currentGenerationId ? `?generationId=${encodeURIComponent(currentGenerationId)}` : '';
      const res = await api.get(`/projects/${current.id}/scenarios${genQs}`);
      const list = Array.isArray(res?.scenarios) ? res.scenarios : [];
      setScenarios(list);
      _scenariosCache[current.id] = list;
      // Seed per-step verdicts from RunResult.stepResults (available once the
      // add_step_results migration is applied). The page renders the post-run
      // icons immediately on reload instead of showing untyped steps.
      const seed = {};
      for (const s of list) {
        for (const c of s.cases) {
          const raw = c.latestResult?.stepResults;
          if (!raw) continue;
          try {
            const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!Array.isArray(arr)) continue;
            const m = {};
            for (const sr of arr) m[sr.index] = { status: sr.status, error: sr.error || null, assertion: sr.assertion || null, operationCheck: sr.operationCheck || null };
            seed[c.id] = m;
          } catch (_) {}
        }
      }
      if (Object.keys(seed).length > 0) {
        setStepStatusByTc((prev) => ({ ...prev, ...seed }));
      }
      loaded = true;
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    return loaded;
  }, [current, currentGenerationId, toast]);

  useEffect(() => { load(); }, [load]);

  const loadTriggerSettings = useCallback(async () => {
    if (!current?.id) {
      setTriggerDraft(DEFAULT_TRIGGER_CONFIG);
      setAuthFixtures([]);
      return;
    }
    setTriggerLoading(true);
    try {
      const [triggerRes, fixturesRes, projectRes] = await Promise.all([
        api.get(`/projects/${current.id}/trigger-config`).catch(() => ({ config: DEFAULT_TRIGGER_CONFIG })),
        api.get(`/projects/${current.id}/auth-fixtures`).catch(() => []),
        api.get(`/projects/${current.id}`).catch(() => ({ project: current })),
      ]);
      const project = projectRes?.project || current;
      const config = triggerRes?.config || DEFAULT_TRIGGER_CONFIG;
      setTriggerDraft({
        ...DEFAULT_TRIGGER_CONFIG,
        ...config,
        execMode: project?.execMode === 'thorough' ? 'thorough' : 'fast',
        defaultAuthFixtureId: project?.defaultAuthFixtureId || '',
      });
      setAuthFixtures(Array.isArray(fixturesRes) ? fixturesRes : fixturesRes?.fixtures || []);
    } finally {
      setTriggerLoading(false);
    }
  }, [current]);

  useEffect(() => {
    loadTriggerSettings();
  }, [loadTriggerSettings]);

  // Isolation — the scenarios state is seeded by a LAZY initializer that only
  // runs on first mount, so on a project switch it would keep showing the
  // previous project's scenarios until load() resolves. Reset to the new
  // project's cached scenarios (or empty) the instant the project changes.
  useEffect(() => {
    setScenarios(_scenariosCache[current?.id] ?? []);
    setExpanded(new Set());
    setHoverScenarioId(null);
    if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0;
  }, [current?.id, currentGenerationId]);

  // Fetch requirement doc count once per project — decides which empty state to show.
  useEffect(() => {
    if (!current?.id) { setReqCount(null); return; }
    let alive = true;
    api.get(`/projects/${current.id}/requirements`)
      .then((data) => {
        if (!alive) return;
        // API returns { success, requirements: [...] } — not a plain array.
        const list = data?.requirements ?? (Array.isArray(data) ? data : []);
        setReqCount(Array.isArray(list) ? list.length : 0);
      })
      .catch(() => { if (alive) setReqCount(null); });
    return () => { alive = false; };
  }, [current?.id]);

  // Check whether any runs exist for this project — drives the Run button
  // label. Runs once per project (not per scenario reload) because the
  // button only needs to flip once.
  useEffect(() => {
    if (!current?.id) { setHasRuns(false); return; }
    let alive = true;
    api.get(`/runs?projectId=${current.id}&limit=1`)
      .then((res) => { if (alive) setHasRuns((Array.isArray(res?.runs) ? res.runs : []).length > 0); })
      .catch(() => {});
    return () => { alive = false; };
  }, [current?.id]);

  // null contextHeadless means "no explicit choice yet" — mcp.js falls back
  // to the QAAI_MCP_HEADLESS/PLAYWRIGHT_MCP_HEADLESS env default (headed).
  // Surfaced as headless=false until the project actually has a value.
  useEffect(() => {
    if (!current?.id) { setHeadlessMode(null); return; }
    let alive = true;
    api.get(`/projects/${current.id}/browser-context`)
      .then((res) => { if (alive) setHeadlessMode(res?.context?.contextHeadless ?? false); })
      .catch(() => { if (alive) setHeadlessMode(false); });
    return () => { alive = false; };
  }, [current?.id]);

  const handleToggleHeadless = useCallback(async () => {
    if (!current?.id || headlessSaving) return;
    const next = !headlessMode;
    setHeadlessSaving(true);
    setHeadlessMode(next);
    try {
      await api.put(`/projects/${current.id}/browser-context`, { contextHeadless: next });
      toast.success(`Live runs will launch ${next ? 'headless (no visible window)' : 'headed (visible window)'} starting with the next run.`);
    } catch (err) {
      setHeadlessMode(!next);
      toast.error(err.message || 'Could not update the browser launch mode.');
    } finally {
      setHeadlessSaving(false);
    }
  }, [current, headlessMode, headlessSaving, toast]);

  // Hydrate smoke selection from localStorage when the project changes.
  // Each project keeps its own picks — switching projects must not show
  // the previous project's set or leak IDs that don't belong to the new
  // project's test cases.
  useEffect(() => {
    if (!current?.id) { setSmokeIds(new Set()); return; }
    try {
      const raw = localStorage.getItem(`qaai:smoke:${current.id}`);
      const ids = raw ? JSON.parse(raw) : [];
      setSmokeIds(new Set(Array.isArray(ids) ? ids : []));
    } catch (_) {
      setSmokeIds(new Set());
    }
  }, [current?.id]);

  // Persist smoke selection on every change. Cheap (single localStorage
  // write per toggle) and survives Vite hot-reloads + page reloads.
  useEffect(() => {
    if (!current?.id) return;
    try {
      localStorage.setItem(`qaai:smoke:${current.id}`, JSON.stringify([...smokeIds]));
    } catch (_) { /* localStorage full or disabled — degrade gracefully */ }
  }, [smokeIds, current?.id]);

  const toggleSmoke = useCallback((id) => setSmokeIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const clearSmoke = useCallback(() => setSmokeIds(new Set()), []);

  useEffect(() => {
    const unsub = subscribe((msg) => {
      if (msg.projectId && current?.id && msg.projectId !== current.id) return;
      if (msg.type === 'authoring.progress' && current?.id) {
        const common = {
          type: msg.action || 'regenerate',
          status: msg.status || 'running',
          progress: Number.isFinite(Number(msg.progress)) ? Number(msg.progress) : undefined,
          phase: msg.phase || null,
          message: msg.message || null,
          operationId: msg.operationId || null,
          source: 'server',
        };
        if (msg.scope === 'scenario') {
          const scenarioPatch = {
            ...common,
            type: msg.action === 'refine' ? 'refine' : 'regenerate',
            scenarioId: msg.scenarioId || null,
            scenarioName: msg.scenarioName || null,
            scenarioLabel: msg.scenarioLabel || null,
            caseCount: msg.caseCount || null,
          };
          const entries = [];
          if (msg.scenarioId) entries.push([msg.scenarioId, scenarioPatch]);
          for (const id of msg.newScenarioIds || []) entries.push([id, { ...scenarioPatch, scenarioId: id }]);
          for (const s of msg.scenarios || []) {
            if (s?.id) entries.push([s.id, {
              ...scenarioPatch,
              scenarioId: s.id,
              scenarioName: s.name || scenarioPatch.scenarioName,
              scenarioLabel: s.scenarioLabel || scenarioPatch.scenarioLabel,
              caseCount: s.caseCount ?? scenarioPatch.caseCount,
            }]);
          }
          patchManyOperationSnapshots(current.id, 'scenarioOps', entries);
        } else if (msg.scope === 'case' && msg.testCaseId) {
          patchOperationSnapshot(current.id, 'caseOps', msg.testCaseId, {
            ...common,
            type: 'refine',
            testCaseId: msg.testCaseId,
            testCaseName: msg.testCaseName || null,
          });
        }
        return;
      }
      if (msg.type === 'result' && msg.tcId) {
        // CRIT-6 / Bug A: do NOT overwrite c.status with msg.status — that
        // collapsed "approved" into "pass/fail/blocked" and broke the
        // approval count. Execution outcome lives on c.latestResult; the
        // approval state on c.status is preserved (the backend snaps it
        // back to 'approved' the moment the case finishes).
        setScenarios((all) =>
          all.map((s) => ({
            ...s,
            cases: s.cases.map((c) => (c.id === msg.tcId
              ? {
                  ...c,
                  status: 'approved',
                  latestResult: {
                    ...(c.latestResult || {}),
                    status: msg.status,
                    error: msg.error ?? c.latestResult?.error ?? null,
                    durationMs: msg.durationMs ?? c.latestResult?.durationMs ?? null,
                  },
                }
              : c)),
          })),
        );
      }
      // Bug B: per-step verdict stream (live spinner → check/cross/blocked
      // in the expanded view). State shape: { [tcId]: { [stepIndex]: {status, error} } }.
      if (msg.type === 'step.start' && msg.tcId) {
        setStepStatusByTc((prev) => ({ ...prev, [msg.tcId]: {} }));
      } else if (msg.type === 'step.progress' && msg.tcId && msg.stepIndex) {
        setStepStatusByTc((prev) => ({
          ...prev,
          [msg.tcId]: {
            ...(prev[msg.tcId] || {}),
            [msg.stepIndex]: { ...(prev[msg.tcId]?.[msg.stepIndex] || {}), status: 'running', error: null },
          },
        }));
      } else if (msg.type === 'step.complete' && msg.tcId && msg.stepIndex) {
        setStepStatusByTc((prev) => ({
          ...prev,
          [msg.tcId]: {
            ...(prev[msg.tcId] || {}),
            [msg.stepIndex]: {
              ...(prev[msg.tcId]?.[msg.stepIndex] || {}),
              status: msg.status,
              error: msg.error || null,
              assertion: msg.assertion || prev[msg.tcId]?.[msg.stepIndex]?.assertion || null,
              operationCheck: msg.operationCheck || prev[msg.tcId]?.[msg.stepIndex]?.operationCheck || null,
            },
          },
        }));
      } else if (msg.type === 'step.assertion' && msg.tcId && msg.stepIndex) {
        setStepStatusByTc((prev) => ({
          ...prev,
          [msg.tcId]: {
            ...(prev[msg.tcId] || {}),
            [msg.stepIndex]: {
              ...(prev[msg.tcId]?.[msg.stepIndex] || { status: 'running', error: null }),
              assertion: {
                status: msg.status,
                expected: msg.expected,
                matched: msg.matched,
                checked: msg.checked === true,
                reason: msg.reason || null,
                evidence: msg.evidence || null,
                channel: msg.channel || null,
                synthetic: msg.synthetic === true,
              },
            },
          },
        }));
      } else if (msg.type === 'step.operationCheck' && msg.tcId && msg.stepIndex) {
        setStepStatusByTc((prev) => ({
          ...prev,
          [msg.tcId]: {
            ...(prev[msg.tcId] || {}),
            [msg.stepIndex]: {
              ...(prev[msg.tcId]?.[msg.stepIndex] || { status: 'running', error: null }),
              status: (msg.status === 'fail' || msg.status === 'blocked')
                ? 'blocked'
                : (prev[msg.tcId]?.[msg.stepIndex]?.status || 'running'),
              error: (msg.status === 'fail' || msg.status === 'blocked')
                ? (msg.reason || msg.evidence || prev[msg.tcId]?.[msg.stepIndex]?.error || null)
                : (prev[msg.tcId]?.[msg.stepIndex]?.error || null),
              operationCheck: {
                status: msg.status,
                expected: msg.expected,
                matched: msg.matched,
                checked: msg.checked === true,
                reason: msg.reason || null,
                evidence: msg.evidence || null,
                channel: msg.channel || null,
                kind: msg.kind || null,
                target: msg.target || null,
                required: msg.required === true,
                synthetic: msg.synthetic === true,
              },
            },
          },
        }));
      } else if (msg.type === 'step.summary' && msg.tcId && Array.isArray(msg.stepResults)) {
        const m = {};
        for (const s of msg.stepResults) m[s.index] = { status: s.status, error: s.error || null, assertion: s.assertion || null, operationCheck: s.operationCheck || null };
        setStepStatusByTc((prev) => ({ ...prev, [msg.tcId]: m }));
      }
      if (msg.type === 'run.complete') load();
      if (msg.type === 'agent.phase.start' && (msg.phase === 'architect' || msg.phase === 'analyst' || msg.phase === 'crawl')) {
        setActivePhase(msg.phase);
        setPhaseStatus('running');
        setPhaseLog('');
        phaseStartedAtRef.current = Date.now();
      } else if (msg.type === 'agent.phase.log' && (msg.phase === 'architect' || msg.phase === 'analyst' || msg.phase === 'crawl')) {
        if (msg.message) setPhaseLog(msg.message);
        setPhaseStatus((prev) => (prev === 'idle' ? 'running' : prev));
        if (!phaseStartedAtRef.current) phaseStartedAtRef.current = Date.now();
      } else if (msg.type === 'agent.phase.complete' && (msg.phase === 'architect' || msg.phase === 'analyst' || msg.phase === 'crawl')) {
        if (msg.cancelled || msg.error === 'cancelled') {
          setPhaseStatus('cancelled');
          setGenerating(false);
        } else if (msg.error) {
          setPhaseStatus('error');
          setPhaseLog(msg.error);
          setGenerating(false);
        } else {
          setPhaseStatus('complete');
          setGenerating(false);
          load(); // refresh scenarios — essential when recovering after a page refresh mid-generation
        }
      }
    });
    return unsub;
  }, [subscribe, load, current?.id]);

  useEffect(() => {
    // On project switch: clear all local phase state. Unlike the lazy initialisers
    // (which seed from global state on first mount), this effect handles switching
    // to a DIFFERENT project where the prior phase data must not carry over.
    setActivePhase(null); setPhaseStatus('idle'); setPhaseLog('');
    setAddScenarioPreview(null);
    setAddScenarioPreviewRequest(null);
    phaseStartedAtRef.current = 0;
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount or project switch: recover `generating` state if a scenario
  // generation was started before this page session (page refresh, nav back).
  // The server distinguishes generation from execution via generationRunning.
  useEffect(() => {
    if (!current?.id) return;
    api.get(`/projects/${current.id}/agents/status`)
      .then((data) => {
        if (data?.generationRunning) setGenerating(true);
      })
      .catch(() => {});
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phaseStatus !== 'running' && phaseStatus !== 'cancelling') return;
    const id = setInterval(() => setPhaseElapsed(Math.floor((Date.now() - phaseStartedAtRef.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [phaseStatus]);

  useEffect(() => {
    if (phaseStatus === 'idle' || phaseStatus === 'running' || phaseStatus === 'cancelling') return;
    const ms = phaseStatus === 'cancelled' ? 5_000 : phaseStatus === 'complete' ? 8_000 : 10_000;
    const t = setTimeout(() => setActivePhase(null), ms);
    return () => clearTimeout(t);
  }, [phaseStatus]);

  // ── Step authoring handlers ─────────────────────────────────────────────
  const applyStepMutation = useCallback((testCaseId, result, fallbackSteps) => {
    setScenarios((all) => all.map((scenario) => ({
      ...scenario,
      cases: scenario.cases.map((testCase) => (
        testCase.id === testCaseId
          ? mergeStepMutationResult(testCase, result, fallbackSteps)
          : testCase
      )),
    })));
  }, []);

  const handleAddStep = useCallback(async (testCase, draft) => {
    if (!testCase?.id || !draft?.instruction?.trim()) return null;
    const result = await api.post(`/test-cases/${encodeURIComponent(testCase.id)}/steps`, {
      projectId: current?.id,
      authoredText: draft.instruction.trim(),
      instruction: draft.instruction.trim(),
      action: draft.action.trim() || null,
      target: draft.target.trim() || null,
      value: draft.value,
      validation: draft.validation.trim() || null,
      condition: draft.condition.trim() || null,
      source: 'user_edit',
      applyTo: 'next_execution',
    });
    const returnedStep = result?.step || result?.createdStep || null;
    const fallbackSteps = returnedStep
      ? [...(Array.isArray(testCase.steps) ? testCase.steps : []), returnedStep]
      : undefined;
    applyStepMutation(testCase.id, result, fallbackSteps);
    if (!result?.testCase && !result?.case && !Array.isArray(result?.steps) && !returnedStep) await load();
    toast.success(
      testCase.status === 'running'
        ? 'Step added. It will apply to the next execution.'
        : 'Step added in the requested position.',
      { title: 'Test step added' },
    );
    return result;
  }, [applyStepMutation, current?.id, load, toast]);

  const handleSaveStep = useCallback(async (testCase, stepId, draft) => {
    if (!testCase?.id || !stepId || !draft?.instruction?.trim()) return null;
    const result = await api.patch(
      `/test-cases/${encodeURIComponent(testCase.id)}/steps/${encodeURIComponent(stepId)}`,
      {
        projectId: current?.id,
        authoredText: draft.instruction.trim(),
        instruction: draft.instruction.trim(),
        action: draft.action.trim() || null,
        target: draft.target.trim() || null,
        value: draft.value,
        validation: draft.validation.trim() || null,
        condition: draft.condition.trim() || null,
        source: 'user_edit',
        applyTo: 'next_execution',
      },
    );
    let changedPrimary = false;
    const fallbackSteps = (Array.isArray(testCase.steps) ? testCase.steps : []).map((step, sourceIndex) => {
      if (stepLogicalIdentity(step, sourceIndex) !== stepId) return step;
      const isPrimary = !changedPrimary;
      changedPrimary = true;
      return {
        ...step,
        authoredText: draft.instruction.trim(),
        text: draft.instruction.trim(),
        ...(isPrimary && draft.action.trim() ? { action: draft.action.trim(), type: draft.action.trim() } : {}),
        ...(isPrimary && draft.target.trim() ? { target: draft.target.trim(), element: draft.target.trim() } : {}),
        ...(isPrimary ? { value: draft.value } : {}),
        ...(isPrimary && draft.validation.trim() ? { expected: draft.validation.trim() } : {}),
        ...(isPrimary && draft.condition.trim() ? { condition: draft.condition.trim() } : {}),
        userEdited: true,
      };
    });
    applyStepMutation(testCase.id, result, fallbackSteps);
    toast.success(
      testCase.status === 'running'
        ? 'Saved. This change will apply to the next execution.'
        : 'The step was replaced in the same position.',
      { title: 'Test step updated' },
    );
    return result;
  }, [applyStepMutation, current?.id, toast]);

  const handleRemoveStep = useCallback(async (testCase, stepId, label) => {
    if (!testCase?.id || !stepId) return null;
    const accepted = await confirm({
      title: 'Remove this step?',
      message: (
        <div className="space-y-2">
          <p className="text-ink-700">{label || 'This step'} will be removed from future executions.</p>
          <p className="text-info-700">QAAI will renumber the remaining steps and adapt straightforward dependencies automatically.</p>
          {testCase.status === 'running' ? (
            <p className="font-medium text-info-800">The active run keeps its original step snapshot.</p>
          ) : null}
        </div>
      ),
      confirmLabel: 'Remove step',
      cancelLabel: 'Keep step',
      variant: 'danger',
    });
    if (!accepted) return null;

    const result = await api.del(
      `/test-cases/${encodeURIComponent(testCase.id)}/steps/${encodeURIComponent(stepId)}?projectId=${encodeURIComponent(current?.id || '')}`,
    );
    const fallbackSteps = (Array.isArray(testCase.steps) ? testCase.steps : [])
      .filter((step, sourceIndex) => stepLogicalIdentity(step, sourceIndex) !== stepId);
    applyStepMutation(testCase.id, result, fallbackSteps);
    toast.success(
      testCase.status === 'running'
        ? 'Step removed for the next execution. Undo remains available in the step panel.'
        : 'Step removed and the remaining steps were renumbered.',
      { title: 'Test step removed' },
    );
    return result;
  }, [applyStepMutation, confirm, current?.id, toast]);

  const handleReorderSteps = useCallback(async (testCase, logicalStepIds) => {
    if (!testCase?.id || !Array.isArray(logicalStepIds)) return null;
    const result = await api.patch(
      `/test-cases/${encodeURIComponent(testCase.id)}/steps/order`,
      {
        projectId: current?.id,
        logicalStepIds,
        stepIds: logicalStepIds,
        applyTo: 'next_execution',
      },
    );
    const buckets = new Map();
    for (const [sourceIndex, step] of (Array.isArray(testCase.steps) ? testCase.steps : []).entries()) {
      const identity = stepLogicalIdentity(step, sourceIndex);
      const bucket = buckets.get(identity) || [];
      bucket.push(step);
      buckets.set(identity, bucket);
    }
    const fallbackSteps = logicalStepIds.flatMap((identity) => buckets.get(identity) || []);
    applyStepMutation(testCase.id, result, fallbackSteps);
    toast.success(
      testCase.status === 'running'
        ? 'Step order saved for the next execution.'
        : 'Step order updated.',
      { title: 'Steps reordered' },
    );
    return result;
  }, [applyStepMutation, current?.id, toast]);

  const handleUndoStep = useCallback(async (testCase, stepId, undoToken) => {
    if (!testCase?.id || !stepId) return null;
    const result = await api.post(
      `/test-cases/${encodeURIComponent(testCase.id)}/steps/undo`,
      {
        projectId: current?.id,
        stepId,
        undoToken,
        applyTo: 'next_execution',
      },
    );
    applyStepMutation(testCase.id, result);
    if (!result?.testCase && !result?.case && !Array.isArray(result?.steps)) await load();
    toast.success(
      testCase.status === 'running'
        ? 'Step restored for the next execution.'
        : 'The removed step was restored.',
      { title: 'Removal undone' },
    );
    return result;
  }, [applyStepMutation, current?.id, load, toast]);

  // ── Other action handlers ───────────────────────────────────────────────
  const handleTerminate = useCallback(async () => {
    if (!current || phaseStatus !== 'running') return;
    setPhaseStatus('cancelling');
    try { await api.post(`/projects/${current.id}/agents/cancel`, {}); }
    catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not cancel' });
      setPhaseStatus('running');
    }
  }, [current, phaseStatus, toast]);

  const handleGenerate = useCallback(async (sessionGuidance = null, replace = true, options = {}) => {
    if (replace && typeof replace === 'object') {
      options = replace;
      replace = true;
    }
    if (!current) return;
    setGenerating(true);
    try {
      const body = { replace };
      if (sessionGuidance) body.sessionGuidance = sessionGuidance;
      if (options?.module) body.module = options.module;
      if (options?.guidanceId) body.guidanceId = options.guidanceId;
      if (options?.focusArea) body.focusArea = options.focusArea;
      if (options?.generationMode) body.generationMode = options.generationMode;
      // Honor the explicit "Rebuild site atlas" toggle; otherwise the backend
      // decides reuse-vs-recrawl (never an unconditional crawl from the client).
      if (options?.forceAtlasRefresh) body.forceAtlasRefresh = true;
      const res = await api.post(`/projects/${current.id}/scenarios/generate`, body);
      toast.success(
        `${res?.stats?.scenarios ?? '?'} scenarios · ${res?.stats?.cases ?? '?'} test cases`,
        { title: 'Architect finished — review and approve below' },
      );
      // Versioning — a generate creates a NEW generation; switch the workspace
      // to it (re-fires the scoped load via the currentGenerationId dep) and
      // refresh the picker list. Falls back to a plain reload on older servers.
      if (res?.generationId) {
        await refreshGenerations();
        switchGeneration(res.generationId);
      } else {
        await load();
      }
      // Show the Approve-all banner so the user knows the next step.
      setSearchParams((prev) => {
        const n = new URLSearchParams(prev);
        n.set('just', 'generated');
        if (options?.module) n.set('module', options.module);
        else n.delete('module');
        return n;
      });
    } catch (err) {
      // The raw error may be "400 {\"type\":\"error\",\"error\":{\"message\":\"...\"}}"
      // — extract the human-readable string nested inside the Anthropic JSON body.
      let raw = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      try {
        const jsonStart = raw.indexOf('{');
        if (jsonStart >= 0) {
          const parsed = JSON.parse(raw.slice(jsonStart));
          raw = parsed?.error?.message || parsed?.message || raw;
        }
      } catch (_) {}
      toast.error(raw, { title: 'Generation failed' });
    } finally {
      setGenerating(false);
    }
  }, [current, toast, load, setSearchParams, refreshGenerations, switchGeneration]);

  // New batch — re-opens the GenerateConfigCard so the user can pick a DIFFERENT
  // mode/focus and generate a fresh generation (vs. the empty-state first run).
  // This supersedes the old blind "Regenerate all": from the config card the user
  // can simply hit Generate with the defaults to get the same effect, OR choose a
  // new mode. Versioning is NON-destructive — the current scenarios stay under the
  // version selector in the header (regenerate keeps history). Routed through
  // handleGenerate(replace:true), which creates AND switches to the new generation.
  // Stale per-generation selections (smoke set, bulk set, step status) are cleared
  // first because their case IDs belong to the outgoing generation.
  const handleGenerateNewBatch = useCallback(async (sessionGuidance = null, options = {}) => {
    setSmokeIds(new Set());
    setBulkIds(new Set());
    setStepStatusByTc({});
    setShowNewBatch(false);
    await handleGenerate(sessionGuidance, true, options);
  }, [handleGenerate]);

  // "+ Add scenario" — APPEND a user-designed scenario to the CURRENT generation
  // (does NOT create a new generation or disturb existing cases). The backend
  // grounds it against the site atlas + test data and emits typed verify + data
  // binding; the journey flag tells the architect to author ONE end-to-end flow
  // rather than decomposing into atomic cases.
  const handleInterpretAddScenario = useCallback(async (requestPayload = {}) => {
    const {
      design,
      continuationParentCaseId = null,
    } = requestPayload;
    if (!current || !design?.trim() || interpretationSubmitting) return;
    setInterpretationSubmitting(true);
    try {
      const result = await api.post(`/projects/${current.id}/scenarios/interpret-preview`, {
        design,
        continuationParentCaseId,
        generationId: currentGenerationId,
      });
      setInterpretationPreview({
        ...result,
        originalDesign: design,
        originalRequest: { ...requestPayload, design },
        continuationParentCaseId: continuationParentCaseId || null,
        generationId: currentGenerationId,
      });
      setShowAddScenario(false);
      toast.success('QAAI interpretation is ready. Nothing was saved.', {
        title: 'Interpretation preview ready',
      });
    } catch (err) {
      const payload = err instanceof ApiError ? err.payload : err?.payload;
      toast.error(payload?.message || err?.message || 'QAAI interpretation preview failed.', {
        title: payload?.code || 'Interpretation preview failed',
        ttl: 15000,
      });
    } finally {
      setInterpretationSubmitting(false);
    }
  }, [current, currentGenerationId, interpretationSubmitting, toast]);

  const handleRefineInterpretationPreview = useCallback(async (guidance) => {
    if (!current || !interpretationPreview?.interpretation || !guidance?.trim() || interpretationRefining) return;
    const currentPreview = interpretationPreview;
    setInterpretationRefining(true);
    try {
      const result = await api.post(`/projects/${current.id}/scenarios/interpret-preview/refine`, {
        design: currentPreview.originalDesign,
        interpretation: currentPreview.interpretation,
        guidance: guidance.trim(),
      });
      setInterpretationPreview({
        ...currentPreview,
        ...result,
        originalDesign: currentPreview.originalDesign,
        continuationParentCaseId: currentPreview.continuationParentCaseId,
        generationId: currentPreview.generationId,
      });
      toast.success('QAAI changed only the requested operations. Review the updated draft.', { title: 'Interpretation refined' });
    } catch (err) {
      const payload = err instanceof ApiError ? err.payload : err?.payload;
      toast.error(payload?.message || err?.message || 'QAAI could not apply that correction.', {
        title: payload?.code || 'Refinement failed', ttl: 15000,
      });
    } finally {
      setInterpretationRefining(false);
    }
  }, [current, interpretationPreview, interpretationRefining, toast]);

  const handleApproveInterpretationPreview = useCallback(async () => {
    if (!current || !interpretationPreview?.interpretation || interpretationApproving) return;
    setInterpretationApproving(true);
    let approvalPersisted = false;
    try {
      const draftResult = await api.post(`/projects/${current.id}/scenarios/interpret-preview/draft`, {
        design: interpretationPreview.originalDesign,
        interpretation: interpretationPreview.interpretation,
        continuationParentCaseId: interpretationPreview.continuationParentCaseId,
        generationId: interpretationPreview.generationId || currentGenerationId,
      });
      const draftPreview = normalizeAddScenarioPreviewPayload(draftResult, {
        originalDesign: interpretationPreview.originalDesign,
        generationId: interpretationPreview.generationId || currentGenerationId,
      });
      const approvalEndpoint = draftPreview?.approval?.endpoint;
      const approvalRequest = buildAddScenarioApprovalRequest(draftPreview, interpretationPreview.generationId || currentGenerationId);
      if (!draftPreview?.approval?.enabled || !approvalEndpoint || !approvalRequest) {
        const firstFinding = draftPreview?.clarifications?.findings?.[0];
        throw new Error(firstFinding?.message || 'The reviewed interpretation is not executable yet. Refine the indicated operation before approving.');
      }
      const approvalResult = await api.post(approvalEndpoint, approvalRequest);
      if (!isAddScenarioApprovalPersistenceConfirmed(approvalResult)) {
        throw new Error(approvalResult?.message || 'Approval did not confirm persistence.');
      }
      approvalPersisted = true;
      await refreshGenerations();
      const reloaded = await load();
      if (!reloaded) {
        throw new Error('The scenario was saved, but the current suite could not be refreshed. Reload the page to display it; approving again is safe.');
      }
      setInterpretationPreview(null);
      toast.success('The reviewed scenario was added to the current suite and is ready for normal approval/execution.', { title: 'Scenario added' });
    } catch (err) {
      const payload = err instanceof ApiError ? err.payload : err?.payload;
      const finding = Array.isArray(payload?.findings) ? payload.findings[0] : null;
      toast.error(finding?.message || payload?.message || err?.message || 'The reviewed scenario could not be added.', {
        title: approvalPersisted ? 'Scenario saved; refresh needed' : (payload?.code || 'Scenario not added'), ttl: 18000,
      });
    } finally {
      setInterpretationApproving(false);
    }
  }, [current, currentGenerationId, interpretationApproving, interpretationPreview, load, refreshGenerations, toast]);

  const handleAddScenario = useCallback(async ({
    design,
    journey,
    continuationParentCaseId = null,
    continuationParentScenarioId = null,
    continuationSessionMode = null,
    forceAtlasRefresh = false,
  }) => {
    if (!current || !design?.trim()) return;
    const request = {
      appendToCurrent: true,
      journey: !!journey,
      sessionGuidance: design,
      continuationParentCaseId,
      continuationParentScenarioId,
      continuationSessionMode,
      forceAtlasRefresh: forceAtlasRefresh === true,
      previewOnly: true,
      persist: false,
      reviewMode: 'preview',
    };
    setAddScenarioSubmitting(true);
    try {
      const res = await api.post(`/projects/${current.id}/scenarios/generate`, request);
      const preview = normalizeAddScenarioPreviewPayload(res, {
        originalDesign: design,
        generationId: currentGenerationId,
      });
      if (preview && !preview.persisted) {
        setAddScenarioPreview(preview);
        setAddScenarioPreviewRequest(request);
        setShowAddScenario(false);
        toast.success('The interpreted actions and assertions are ready to review.', {
          title: 'Scenario draft ready',
        });
        return;
      }

      // Compatibility path for servers that still persist Add Scenario directly.
      setShowAddScenario(false);
      toast.success(
        `Added ${res?.stats?.scenarios ?? '1'} scenario${(res?.stats?.scenarios ?? 1) === 1 ? '' : 's'} · ${res?.stats?.cases ?? '?'} case(s)`,
        { title: 'Scenario added to the current suite — review and approve below' },
      );
      if (res?.generationId) {
        await refreshGenerations();
        switchGeneration(res.generationId);
      } else {
        await load();
      }
    } catch (err) {
      const reviewPayload = err instanceof ApiError ? err.payload : err?.payload;
      const preview = normalizeAddScenarioPreviewPayload(reviewPayload, {
        originalDesign: design,
        generationId: currentGenerationId,
      });
      if (preview) {
        setAddScenarioPreview(preview);
        setAddScenarioPreviewRequest(request);
        setShowAddScenario(false);
        return;
      }
      const failure = formatAddScenarioFailure(err);
      toast.error(failure.message, { title: failure.title, ttl: 20000 });
    } finally {
      setAddScenarioSubmitting(false);
    }
  }, [current, currentGenerationId, toast, load, refreshGenerations, switchGeneration]);

  const handleContinueDeterministicPreview = useCallback(async () => {
    const request = interpretationPreview?.originalRequest || {
      design: interpretationPreview?.originalDesign,
      continuationParentCaseId: interpretationPreview?.continuationParentCaseId || null,
      journey: true,
    };
    if (!request?.design?.trim()) return;
    setInterpretationPreview(null);
    await handleAddScenario(request);
  }, [handleAddScenario, interpretationPreview]);

  const handleDiscardAddScenarioPreview = useCallback(() => {
    if (previewRefining || previewApproving) return;
    setAddScenarioPreview(null);
    setAddScenarioPreviewRequest(null);
  }, [previewApproving, previewRefining]);

  const handleRefineAddScenarioPreview = useCallback(async (refinementGuidance) => {
    if (!current || !addScenarioPreviewRequest || !refinementGuidance?.trim() || previewRefining) return;
    if (!addScenarioPreview?.draftId || !addScenarioPreview?.revision) {
      toast.error('This draft has no stable identity and revision, so it was retained without sending a refinement request.', {
        title: 'Draft cannot be refined safely',
        ttl: 12000,
      });
      return;
    }
    const currentPreview = addScenarioPreview;
    setPreviewRefining(true);
    try {
      const res = await api.post(`/projects/${current.id}/scenarios/generate`, {
        ...addScenarioPreviewRequest,
        previewOnly: true,
        persist: false,
        reviewMode: 'preview',
        draftId: currentPreview.draftId,
        previewId: currentPreview.draftId,
        draftRevision: currentPreview.revision,
        previewRevision: currentPreview.revision,
        previewDigest: currentPreview.digest || null,
        refinementGuidance: refinementGuidance.trim(),
      });
      const nextPreview = normalizeAddScenarioPreviewPayload(res, {
        originalDesign: addScenarioPreviewRequest.sessionGuidance,
        generationId: currentGenerationId,
      });
      if (!isValidNewerAddScenarioPreview(currentPreview, nextPreview)) {
        throw new Error('The server returned a stale or malformed refinement. The current draft was kept unchanged.');
      }
      setAddScenarioPreview({
        ...nextPreview,
        refinementChanges: summarizeAddScenarioPreviewChanges(currentPreview, nextPreview),
      });
      toast.success('Your requested changes are ready to review.', { title: 'Scenario draft updated' });
    } catch (err) {
      const reviewPayload = err instanceof ApiError ? err.payload : err?.payload;
      const nextPreview = normalizeAddScenarioPreviewPayload(reviewPayload, {
        originalDesign: addScenarioPreviewRequest.sessionGuidance,
        generationId: currentGenerationId,
      });
      if (isValidNewerAddScenarioPreview(currentPreview, nextPreview)) {
        setAddScenarioPreview({
          ...nextPreview,
          refinementChanges: summarizeAddScenarioPreviewChanges(currentPreview, nextPreview),
        });
      } else {
        toast.error(err?.message || 'The server returned a stale or malformed refinement. The current draft was kept unchanged.', {
          title: 'Refinement not applied',
          ttl: 12000,
        });
      }
    } finally {
      setPreviewRefining(false);
    }
  }, [addScenarioPreview, addScenarioPreviewRequest, current, currentGenerationId, previewRefining, toast]);

  const handleApproveAddScenarioPreview = useCallback(async () => {
    const approvalEndpoint = addScenarioPreview?.approval?.endpoint;
    const approvalRequest = buildAddScenarioApprovalRequest(addScenarioPreview, currentGenerationId);
    if (!current || !addScenarioPreview?.approval?.enabled || !approvalEndpoint || !approvalRequest || previewApproving) return;
    setPreviewApproving(true);
    let approvalPersisted = false;
    try {
      const res = await api.post(approvalEndpoint, approvalRequest);
      if (!isAddScenarioApprovalPersistenceConfirmed(res)) {
        toast.error(res?.message || 'Approval did not confirm persistence. The reviewed draft was retained.', {
          title: res?.code ? `Approval not applied · ${res.code}` : 'Approval not applied',
          ttl: 12000,
        });
        return;
      }
      approvalPersisted = true;
      await refreshGenerations();
      const reloaded = await load();
      if (!reloaded) {
        throw new Error('The scenario was saved, but the current suite could not be refreshed. Reload the page to display it; approving again is safe.');
      }
      setAddScenarioPreview(null);
      setAddScenarioPreviewRequest(null);
      toast.success('The reviewed scenario was added to the suite.', { title: 'Scenario approved' });
    } catch (err) {
      const reviewPayload = err instanceof ApiError ? err.payload : err?.payload;
      toast.error(reviewPayload?.message || err?.message || 'The draft could not be approved. The reviewed draft was retained.', {
        title: approvalPersisted
          ? 'Scenario saved; refresh needed'
          : (reviewPayload?.code ? `Approval not applied · ${reviewPayload.code}` : 'Approval failed'),
        ttl: 12000,
      });
    } finally {
      setPreviewApproving(false);
    }
  }, [addScenarioPreview, current, currentGenerationId, load, previewApproving, refreshGenerations, toast]);

  const handleApproveAll = useCallback(async () => {
    if (!current || approvingRef.current) return;
    approvingRef.current = true;
    setApproving(true);
    try {
      const res = await api.post(`/projects/${current.id}/test-cases/approve-all`, {});
      await load();
      const blocked = Array.isArray(res?.blocked) ? res.blocked : [];
      if (blocked.length) {
        const names = blocked.slice(0, 4).map((b) => b.name).join(', ');
        toast.warning(
          `Approved ${res?.updated ?? 0} case(s). Held back ${blocked.length} with blocking defects: ${names}${blocked.length > 4 ? `, +${blocked.length - 4} more` : ''}. Fix the generation / data binding (or regenerate) before approving — a blocked case can never run.`,
          { title: `${blocked.length} case${blocked.length === 1 ? '' : 's'} held back`, ttl: 12000 },
        );
      } else {
        toast.success(`Approved ${res?.updated ?? 'all pending'} test case(s).`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  }, [current, toast, load]);

  const handleSmartSelect = useCallback(async () => {
    if (!current) return;
    setSelecting(true);
    try {
      const res = await api.post(`/projects/${current.id}/analyst/select-impacted`, {});
      toast.success(
        `${res.impacted} of ${res.total} scenario(s) flagged as impacted by Release Notes.`,
        { title: 'Smart selection complete' }
      );
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.payload?.code === 'NO_RELEASE_NOTES') {
        toast.error(err.payload.message, { title: 'No release notes', ttl: 8000 });
      } else {
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        toast.error(msg, { title: 'Smart selection failed' });
      }
    } finally {
      setSelecting(false);
    }
  }, [current, toast, load]);

  // ── Per-tab scenario derivation ─────────────────────────────────────────
  // Cases classified `automatability: 'manual'` live on a dedicated tab —
  // they're not eligible for the Playwright run path. Pre-filter once so
  // every downstream useMemo (counts, runCostEstimate, FilterRail, visible
  // list, impactedPending, handleExecute) naturally operates on the right
  // subset. MUST be declared BEFORE any hook that depends on it — moved
  // here from below `counts` after a TDZ runtime crash in 26.05.27.
  const automationScenarios = useMemo(
    () => scenarios
      .map((s) => ({ ...s, cases: s.cases.filter((c) => (c.automatability || 'automatable') !== 'manual') }))
      .filter((s) => s.cases.length > 0),
    [scenarios],
  );
  const manualScenarios = useMemo(
    () => scenarios
      .map((s) => ({ ...s, cases: s.cases.filter((c) => c.automatability === 'manual') }))
      .filter((s) => s.cases.length > 0),
    [scenarios],
  );
  const automationCasesTotal = useMemo(
    () => automationScenarios.reduce((a, s) => a + s.cases.length, 0),
    [automationScenarios],
  );
  const manualCasesTotal = useMemo(
    () => manualScenarios.reduce((a, s) => a + s.cases.length, 0),
    [manualScenarios],
  );
  const manualCasesCompleted = useMemo(
    () => manualScenarios.reduce((a, s) => a + s.cases.filter((c) => c.manualCompletedAt).length, 0),
    [manualScenarios],
  );
  // The scenario list the rest of the page operates against. On the Manual
  // tab counts / filters / etc. are still computed against the automation
  // pool (because that's what the Run CTA cares about), but the rendered
  // list switches to the Manual panel via the `automationTab` gate below.
  const tabSourceScenarios = automationScenarios;

  const impactedPending = useMemo(
    () => automationScenarios.filter((s) => s.impacted).flatMap((s) => s.cases.filter((c) => c.status === 'pending')),
    [automationScenarios]
  );

  const handleApproveImpactedOnly = useCallback(async () => {
    if (!current) return;
    if (!impactedPending.length) {
      toast.error('No impacted scenarios with pending cases. Run Smart selection first.');
      return;
    }
    setApproving(true);
    try {
      const res = await api.post(`/projects/${current.id}/test-cases/bulk-update`, {
        ids: impactedPending.map((c) => c.id),
        status: 'approved',
      });
      await load();
      const blocked = Array.isArray(res?.blocked) ? res.blocked : [];
      if (blocked.length) {
        toast.warning(
          `Approved ${res?.updated ?? 0} of the impacted case(s). Held back ${blocked.length} with blocking defects — fix the generation / data binding before approving.`,
          { title: `${blocked.length} case${blocked.length === 1 ? '' : 's'} held back`, ttl: 12000 },
        );
      } else {
        toast.success(`Approved ${res.updated} case(s) in impacted scenarios.`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setApproving(false);
    }
  }, [current, impactedPending, toast, load]);

  const setStatus = async (tc, status) => {
    try {
      await api.put(`/projects/${current.id}/test-cases/${tc.id}`, { status });
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleExecute = useCallback(async ({ execModeOverride, runModeOverride } = {}) => {
    if (!current) return;
    // Only automatable cases are eligible — manuals live on the Manual tab
    // and don't drive Playwright. Match the server-side filter in
    // server/routes/agents.js so the toast count matches what actually runs.
    const approved = approvedAutomationCases(automationScenarios);
    const advisoryBlocked = approved.filter((c) => !isCaseRunEligible(c));
    if (!approved.length) {
      toast.error('Approve at least one automatable test case before running.');
      return;
    }
    // Pre-run assertion quality gate: flag cases with zero declared assertions.
    // These will run but the conductor has no verification target — they usually
    // come back uncheckable. Non-blocking; user can still proceed.
    const zeroAssertionCases = approved.filter((c) => {
      if (!c.declaredAssertions) return true;
      try { const a = JSON.parse(c.declaredAssertions); return !Array.isArray(a) || a.length === 0; }
      catch { return true; }
    });
    // Phase F — show a pre-run cost estimate so the user isn't surprised
    // by a 3M-token burn. Estimate uses the project's execMode profile.
    const execMode = execModeOverride === 'thorough' || current.execMode === 'thorough' ? 'thorough' : 'fast';
    const runMode = runModeOverride === 'sequential' ? 'sequential' : 'grouped';
    const est = estimateConductorRunCost({ caseCount: approved.length, execMode });
    const wantTotalTokens = est.inputTokens + est.outputTokens;
    const minutes = Math.max(1, Math.round(est.secondsEstimate / 60));
    const ok = await confirm({
      title: `Run ${approved.length} test case${approved.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Start run',
      cancelLabel: 'Not yet',
      variant: 'primary',
      message: (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg border border-ink-200 bg-white px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-500">Mode</div>
              <div className={`text-sm font-semibold mt-0.5 ${execMode === 'thorough' ? 'text-accent-700' : 'text-info-700'}`}>
                {execMode === 'thorough' ? 'Thorough' : 'Fast'}
              </div>
            </div>
            <div className="rounded-lg border border-ink-200 bg-white px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-500">Tokens</div>
              <div className="text-sm font-semibold text-ink-900 mt-0.5 font-mono">~{formatTokens(wantTotalTokens)}</div>
            </div>
            <div className="rounded-lg border border-ink-200 bg-white px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-500">Cost</div>
              <div className="text-sm font-semibold text-ink-900 mt-0.5 font-mono">~{est.costDisplay}</div>
            </div>
          </div>
          <p className="text-xs text-ink-600 leading-relaxed">
            Estimated wall-clock: ~{minutes} minute{minutes === 1 ? '' : 's'}. Cost is approximate (Claude
            list pricing) and assumes most cases finish without retries. Failing cases under Thorough
            mode pay extra for the Supervisor pass. Run mode: {runMode === 'sequential' ? 'strict sequential waves' : 'planner grouped waves'}.
          </p>
          {advisoryBlocked.length > 0 && (
            <div className="rounded-md border border-warn-200 bg-warn-50/70 px-2.5 py-2 text-[11px] text-warn-800 leading-relaxed">
              <span className="font-semibold">{advisoryBlocked.length} approved case{advisoryBlocked.length === 1 ? '' : 's'} have readiness warnings.</span>
              {' '}QAAI will still start the run because you approved them; failures may indicate missing data, auth, app coverage, session dependency, or oracle evidence.
            </div>
          )}
          {zeroAssertionCases.length > 0 && (
            <div className="rounded-md border border-warn-200 bg-warn-50/70 px-2.5 py-2 text-[11px] text-warn-800 leading-relaxed">
              <span className="font-semibold">{zeroAssertionCases.length} case{zeroAssertionCases.length === 1 ? '' : 's'} have no assertions.</span>
              {' '}The AI has no verification target for these — they will run but verdicts may come back as{' '}
              <span className="font-mono text-[10px]">uncheckable</span>. Add assertions in Test Cases before running for a conclusive verdict.
            </div>
          )}
          {execMode === 'thorough' && (
            <p className="text-[11px] text-warn-700 bg-warn-50 border border-warn-200 rounded-md px-2.5 py-1.5">
              Thorough mode is ~3× more expensive than Fast. Use it for release-gate runs;
              switch back to Fast in Project Setup for daily iteration.
            </p>
          )}
        </div>
      ),
    });
    if (!ok) return;

    setExecuting(true);
    try {
      await api.post(`/projects/${current.id}/agents/execute`, { runMode, generationId: executionGenerationId });
      toast.success(`${approved.length} test case(s) queued for execution.`, { title: 'Pipeline started' });
      navigate('/live-pipeline');
    } catch (err) {
      const { title, message } = formatRunStartError(err, 'Execution failed');
      toast.error(message, { title });
    } finally {
      setExecuting(false);
    }
  }, [current, automationScenarios, executionGenerationId, toast, navigate, confirm]);

  // ── Smoke-picker launcher ──────────────────────────────────────────────
  // Runs ONLY the cases the user added to the smoke set. Filters to
  // approved cases (the selection can persist across approval/rejection
  // cycles so a previously-picked case may no longer be runnable), shows
  // a cost-preview confirm dialog, then POSTs to /agents/run-smoke.
  const handleRunSmoke = useCallback(async ({ execModeOverride, runModeOverride } = {}) => {
    if (!current || smokeIds.size === 0) return;
    const selectedApproved = automationScenarios.flatMap((s) => s.cases.filter((c) =>
      smokeIds.has(c.id) && (c.status === 'approved' || c.status === 'running'),
    ));
    const advisoryBlocked = selectedApproved.filter((c) => !isCaseRunEligible(c));
    if (selectedApproved.length === 0) {
      toast.error('None of the selected cases are approved. Approve them first, or adjust your selection.');
      return;
    }
    const skipped = smokeIds.size - selectedApproved.length;
    const execMode = execModeOverride === 'thorough' || current.execMode === 'thorough' ? 'thorough' : 'fast';
    const runMode = runModeOverride === 'sequential' ? 'sequential' : 'grouped';
    const est = estimateConductorRunCost({ caseCount: selectedApproved.length, execMode });
    const wantTotalTokens = est.inputTokens + est.outputTokens;
    const minutes = Math.max(1, Math.round(est.secondsEstimate / 60));
    const ok = await confirm({
      title: `Smoke-run ${selectedApproved.length} test case${selectedApproved.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Start smoke',
      cancelLabel: 'Not yet',
      variant: 'primary',
      message: (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg border border-ink-200 bg-white px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-500">Mode</div>
              <div className={`text-sm font-semibold mt-0.5 ${execMode === 'thorough' ? 'text-accent-700' : 'text-info-700'}`}>
                {execMode === 'thorough' ? 'Thorough' : 'Fast'}
              </div>
            </div>
            <div className="rounded-lg border border-ink-200 bg-white px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-500">Tokens</div>
              <div className="text-sm font-semibold text-ink-900 mt-0.5 font-mono">~{formatTokens(wantTotalTokens)}</div>
            </div>
            <div className="rounded-lg border border-ink-200 bg-white px-2 py-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-500">Cost</div>
              <div className="text-sm font-semibold text-ink-900 mt-0.5 font-mono">~{est.costDisplay}</div>
            </div>
          </div>
          <p className="text-xs text-ink-600 leading-relaxed">
            Running only the {selectedApproved.length} approved case{selectedApproved.length === 1 ? '' : 's'} you picked. Estimated wall-clock:
            ~{minutes} minute{minutes === 1 ? '' : 's'}. Your smoke selection stays after the run finishes — clear it
            from the smoke bar at the top if you want a fresh set next time. Run mode: {runMode === 'sequential' ? 'strict sequential waves' : 'planner grouped waves'}.
          </p>
          {advisoryBlocked.length > 0 && (
            <p className="text-[11px] text-warn-700 bg-warn-50 border border-warn-200 rounded-md px-2.5 py-1.5">
              {advisoryBlocked.length} approved case{advisoryBlocked.length === 1 ? '' : 's'} have readiness warnings. They will still be attempted by user choice.
            </p>
          )}
          {skipped > 0 && (
            <p className="text-[11px] text-warn-700 bg-warn-50 border border-warn-200 rounded-md px-2.5 py-1.5">
              {skipped} previously-picked case{skipped === 1 ? '' : 's'} {skipped === 1 ? 'is' : 'are'} not approved
              and will be skipped.
            </p>
          )}
        </div>
      ),
    });
    if (!ok) return;
    setRunningSmoke(true);
    try {
      await api.post(`/projects/${current.id}/agents/run-smoke`, {
        testCaseIds: selectedApproved.map((c) => c.id),
        runMode,
        generationId: executionGenerationId,
      });
      toast.success(`Smoke-running ${selectedApproved.length} case${selectedApproved.length === 1 ? '' : 's'}.`, { title: 'Pipeline started' });
      navigate('/live-pipeline');
    } catch (err) {
      const { title, message } = formatRunStartError(err, 'Smoke failed to start');
      toast.error(message, { title });
    } finally {
      setRunningSmoke(false);
    }
  }, [current, smokeIds, automationScenarios, executionGenerationId, toast, navigate, confirm]);

  const saveTriggerSettings = useCallback(async () => {
    if (!current?.id) return false;
    const execMode = triggerDraft.execMode === 'thorough' ? 'thorough' : 'fast';
    const runScope = triggerDraft.runScope === 'smoke' ? 'smoke' : 'approved';
    const runMode = triggerDraft.runMode === 'sequential' ? 'sequential' : 'grouped';
    const fixtureId = triggerDraft.defaultAuthFixtureId || null;

    setTriggerSaving(true);
    try {
      await api.put(`/projects/${current.id}/trigger-config`, { config: { runScope, runMode } });
      await api.put(`/projects/${current.id}`, { execMode });
      await api.put(`/projects/${current.id}/default-auth-fixture`, { fixtureId });
      await refreshProjects?.();
      await loadTriggerSettings();
      toast.success('Trigger settings saved.');
      return true;
    } catch (err) {
      toast.error(err.message || 'Failed to save trigger settings.', { title: 'Trigger not saved' });
      return false;
    } finally {
      setTriggerSaving(false);
    }
  }, [current?.id, triggerDraft, refreshProjects, loadTriggerSettings, toast]);

  const saveTriggerAndRun = useCallback(async () => {
    const saved = await saveTriggerSettings();
    if (!saved) return;
    setTriggerModalOpen(false);
    const execModeOverride = triggerDraft.execMode === 'thorough' ? 'thorough' : 'fast';
    const runModeOverride = triggerDraft.runMode === 'sequential' ? 'sequential' : 'grouped';
    if (triggerDraft.runScope === 'smoke') {
      await handleRunSmoke({ execModeOverride, runModeOverride });
    } else {
      await handleExecute({ execModeOverride, runModeOverride });
    }
  }, [saveTriggerSettings, triggerDraft.execMode, triggerDraft.runMode, triggerDraft.runScope, handleRunSmoke, handleExecute]);

  // ── Download test plan ─────────────────────────────────────────────────
  // Builds a structured Markdown export of every scenario / case / step in
  // the project. Markdown specifically (not JSON / PDF / Excel) because:
  //   - reads cleanly as-is for stakeholders who just want to skim
  //   - pastes directly into Word / Confluence / Notion preserving structure
  //   - converts to PDF via any markdown→PDF tool when a formal deliverable
  //     is required
  //   - one file, no zip dance, no font / dependency concerns
  // Includes TS-N / TC-N numbering so the doc matches the IDs the live
  // pipeline + reports use; coverage tags from the Architect [Covers: ...]
  // come through inside scenario rationale since they live there verbatim.
  const handleDownloadTestPlan = useCallback(() => {
    if (!current || scenarios.length === 0) {
      toast.error('No scenarios to download yet. Generate scenarios first.');
      return;
    }
    const lines = [];
    const stamp = new Date();
    const allCases = scenarios.flatMap((s) => s.cases || []);
    const auto = allCases.filter((c) => c.automatability !== 'manual');
    const manual = allCases.filter((c) => c.automatability === 'manual');
    const approved = allCases.filter((c) => c.status === 'approved' || c.status === 'running').length;

    lines.push(`# Test Plan — ${current.name}`);
    lines.push('');
    lines.push(`> **Generated:** ${stamp.toLocaleString()}`);
    lines.push(`> **Target URL:** ${current.targetUrl || '—'}`);
    if (current.framework) lines.push(`> **Framework:** ${current.framework}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push(`| Scenarios | ${scenarios.length} |`);
    lines.push(`| Test cases | ${allCases.length} |`);
    lines.push(`| Automation | ${auto.length} |`);
    lines.push(`| Manual | ${manual.length} |`);
    lines.push(`| Approved | ${approved} |`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Scenarios and Test Cases');
    lines.push('');

    scenarios.forEach((s, si) => {
      lines.push(`### TS-${si + 1} — ${s.name}`);
      lines.push('');
      lines.push(`**Priority:** ${s.priority || '—'} · **Category:** ${s.category || '—'} · **Module:** ${s.module || '—'}`);
      lines.push('');
      if (s.rationale) {
        lines.push(`**Rationale:** ${s.rationale}`);
        lines.push('');
      }
      const cases = s.cases || [];
      if (cases.length === 0) {
        lines.push('_No test cases generated for this scenario._');
        lines.push('');
        return;
      }
      cases.forEach((c, ci) => {
        const isManual = c.automatability === 'manual';
        lines.push(`#### TS-${si + 1} · TC-${ci + 1} — ${c.name}`);
        lines.push('');
        const meta = [
          `**Type:** ${c.type || 'functional'}`,
          `**Confidence:** ${c.confidence != null ? c.confidence + '%' : '—'}`,
          `**Status:** ${c.status || '—'}`,
          `**Automatability:** ${isManual ? 'Manual' : 'Automation'}`,
        ];
        lines.push(meta.join(' · '));
        lines.push('');
        if (isManual && c.automatabilityReason) {
          lines.push(`> **Why manual:** ${c.automatabilityReason}`);
          lines.push('');
        }
        if (c.assertions) {
          lines.push(`**Assertions:** ${c.assertions}`);
          lines.push('');
        }
        const steps = Array.isArray(c.steps) ? c.steps : [];
        if (steps.length) {
          lines.push('**Steps:**');
          lines.push('');
          steps.forEach((step, idx) => {
            const action = step.action || 'Action';
            const elem = step.element ? ` — ${step.element}` : '';
            const value = step.value ? ` (value: \`${step.value}\`)` : '';
            lines.push(`${idx + 1}. **${action}**${elem}${value}`);
            if (step.expected) {
              lines.push(`   - _Expected:_ ${step.expected}`);
            }
          });
          lines.push('');
        }
        lines.push('');
      });
      lines.push('---');
      lines.push('');
    });

    const safeName = (current.name || 'project').replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-').toLowerCase() || 'project';
    const ts = stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qaai-test-plan-${safeName}-${ts}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${scenarios.length} scenarios / ${allCases.length} cases.`, { title: 'Test plan exported' });
  }, [current, scenarios, toast]);

  // ── Bulk handlers ───────────────────────────────────────────────────────
  const toggleBulk = (id) => setBulkIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearBulk = () => setBulkIds(new Set());
  const exitBulk = () => { setBulkMode(false); clearBulk(); };

  const bulkUpdateStatus = useCallback(async (status) => {
    if (!current || bulkIds.size === 0) return;
    try {
      const res = await api.post(`/projects/${current.id}/test-cases/bulk-update`, {
        ids: [...bulkIds], status,
      });
      const blocked = Array.isArray(res?.blocked) ? res.blocked : [];
      if (status === 'approved' && blocked.length) {
        toast.warning(
          `Approved ${res?.updated ?? 0} case(s). Held back ${blocked.length} with blocking defects — fix the generation / data binding before approving.`,
          { title: `${blocked.length} case${blocked.length === 1 ? '' : 's'} held back`, ttl: 12000 },
        );
      } else {
        toast.success(`${status === 'approved' ? 'Approved' : 'Rejected'} ${res.updated} case${res.updated === 1 ? '' : 's'}.`);
      }
      await load();
      clearBulk();
    } catch (err) {
      toast.error(err.message);
    }
  }, [current, bulkIds, toast, load]);

  const bulkDelete = useCallback(async () => {
    if (!current || bulkIds.size === 0) return;
    try {
      await api.post(`/projects/${current.id}/test-cases/bulk-update`, {
        ids: [...bulkIds], status: 'rejected',
      });
      toast.success(`Marked ${bulkIds.size} case${bulkIds.size === 1 ? '' : 's'} as rejected.`);
      await load();
      clearBulk();
    } catch (err) {
      toast.error(err.message);
    }
  }, [current, bulkIds, toast, load]);

  // ── Per-scenario regenerate ─────────────────────────────────────────────
  const handleRegenerateScenario = useCallback(async (scenario, guidanceId = null, operationType = 'regenerate', operationIdOverride = null) => {
    if (!current || regenScenarioId) return;
    const operationId = operationIdOverride || makeAuthoringOperationId('scenario', scenario.id);
    setRegenScenarioId(scenario.id);
    patchOperationSnapshot(current.id, 'scenarioOps', scenario.id, {
      type: operationType,
      status: 'running',
      progress: 1,
      phase: 'queued',
      message: 'Queued on the server.',
      operationId,
      source: 'client',
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      scenarioLabel: scenario.scenarioLabel,
      caseCount: scenario.cases?.length || 0,
    });
    try {
      const res = await api.post(`/projects/${current.id}/scenarios/${scenario.id}/regenerate`, {
        ...(guidanceId ? { guidanceId } : {}),
        operationId,
        scenarioLabel: scenario.scenarioLabel,
        caseCount: scenario.cases?.length || 0,
      });
      const regeneratedCount = Array.isArray(res?.scenarios) ? res.scenarios.length : 0;
      patchManyOperationSnapshots(current.id, 'scenarioOps', [
        [scenario.id, {
          type: operationType,
          status: 'done',
          progress: 100,
        }],
        ...(Array.isArray(res?.scenarios) ? res.scenarios : [])
          .filter((s) => s?.id)
          .map((s) => [s.id, {
            type: operationType,
            status: 'done',
            progress: 100,
            scenarioId: s.id,
            scenarioName: s.name || scenario.name,
            scenarioLabel: s.scenarioLabel || scenario.scenarioLabel,
            caseCount: Array.isArray(s.cases) ? s.cases.length : scenario.cases?.length || 0,
          }]),
      ]);
      toast.success(
        `Regenerated "${scenario.name.slice(0, 40)}${scenario.name.length > 40 ? '…' : ''}" — ${regeneratedCount} new scenario(s).`,
        { title: 'Architect finished' },
      );
      await load();
    } catch (err) {
      const cancelled = err instanceof ApiError && err.payload?.code === 'CANCELLED';
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      patchOperationSnapshot(current.id, 'scenarioOps', scenario.id, {
        type: operationType,
        status: 'error',
        progress: 100,
      });
      if (!cancelled) toast.error(msg, { title: 'Regenerate failed' });
    } finally {
      setRegenScenarioId(null);
    }
  }, [current, regenScenarioId, toast, load]);

  const handleRestoreScenario = useCallback(async (scenario) => {
    if (!current || !scenario?.id) return;
    const ok = await confirm({
      title: 'Restore previous scenario?',
      confirmLabel: 'Restore',
      cancelLabel: 'Keep current',
      variant: 'primary',
      message: `This will replace "${scenario.name}" with the version saved before the last targeted AI update.`,
    });
    if (!ok) return;
    try {
      const res = await api.post(`/projects/${current.id}/scenarios/${scenario.id}/restore-latest`, {});
      toast.success(`Restored "${(res.scenario?.name || scenario.name).slice(0, 60)}".`, { title: 'Scenario restored' });
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Restore failed' });
    }
  }, [current, confirm, load, toast]);

  const handleDeleteScenario = useCallback(async (scenario) => {
    if (!current || !scenario?.id || deleteScenarioId) return;
    const caseCount = Array.isArray(scenario.cases) ? scenario.cases.length : 0;
    const ok = await confirm({
      title: 'Delete scenario?',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep scenario',
      variant: 'danger',
      message: `This will permanently delete "${scenario.name}" and ${caseCount} test case${caseCount === 1 ? '' : 's'} from this generation.`,
    });
    if (!ok) return;
    setDeleteScenarioId(scenario.id);
    try {
      const res = await api.del(`/projects/${current.id}/scenarios/${scenario.id}`);
      toast.success(
        `Deleted "${(res?.deletedScenario?.name || scenario.name).slice(0, 60)}" and ${res?.deletedCases ?? caseCount} case${(res?.deletedCases ?? caseCount) === 1 ? '' : 's'}.`,
        { title: 'Scenario deleted' },
      );
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(scenario.id);
        return next;
      });
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Delete failed' });
    } finally {
      setDeleteScenarioId(null);
    }
  }, [current, confirm, deleteScenarioId, load, toast]);

  const handleRestoreCase = useCallback(async (tc) => {
    if (!current || !tc?.id) return;
    const ok = await confirm({
      title: 'Restore previous case?',
      confirmLabel: 'Restore',
      cancelLabel: 'Keep current',
      variant: 'primary',
      message: `This will replace "${tc.name}" with the version saved before the last AI improvement.`,
    });
    if (!ok) return;
    try {
      const res = await api.post(`/projects/${current.id}/test-cases/${tc.id}/restore-latest`, {});
      toast.success(`Restored "${(res.testCase?.name || tc.name).slice(0, 60)}".`, { title: 'Case restored' });
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Restore failed' });
    }
  }, [current, confirm, load, toast]);

  const handleSubmitGuidance = useCallback(async ({ instruction, quickIntents }) => {
    if (!current || !guidanceTarget) return;
    const targetOperationId = guidanceTarget.scope === 'scenario' && guidanceTarget.scenario?.id
      ? makeAuthoringOperationId('scenario', guidanceTarget.scenario.id)
      : guidanceTarget.scope === 'case' && guidanceTarget.case?.id
        ? makeAuthoringOperationId('case', guidanceTarget.case.id)
        : null;
    if (guidanceTarget.scope === 'scenario' && guidanceTarget.scenario?.id) {
      patchOperationSnapshot(current.id, 'scenarioOps', guidanceTarget.scenario.id, {
        type: 'refine',
        status: 'running',
        progress: 1,
        phase: 'guidance',
        message: 'Saving refinement guidance.',
        operationId: targetOperationId,
        source: 'client',
        scenarioId: guidanceTarget.scenario.id,
        scenarioName: guidanceTarget.scenario.name,
        scenarioLabel: guidanceTarget.scenario.scenarioLabel,
        caseCount: guidanceTarget.scenario.cases?.length || 0,
      });
    } else if (guidanceTarget.scope === 'case' && guidanceTarget.case?.id) {
      patchOperationSnapshot(current.id, 'caseOps', guidanceTarget.case.id, {
        type: 'refine',
        status: 'running',
        progress: 1,
        phase: 'guidance',
        message: 'Saving improvement guidance.',
        operationId: targetOperationId,
        source: 'client',
        testCaseId: guidanceTarget.case.id,
        testCaseName: guidanceTarget.case.name,
      });
    }
    setGuidanceSubmitting(true);
    try {
      const subject = guidanceTarget.scope === 'case'
        ? guidanceTarget.case?.name
        : guidanceTarget.scope === 'scenario'
          ? guidanceTarget.scenario?.name
          : current.name;
      const guidanceRes = await api.post(`/projects/${current.id}/generation-guidance`, {
        scope: guidanceTarget.scope,
        sourceSurface: guidanceTarget.scope === 'suite' ? 'test-cases-header' : guidanceTarget.scope === 'scenario' ? 'scenario-card' : 'case-row',
        sprintId: currentSprintId || null,
        generationId: currentGenerationId || null,
        scenarioId: guidanceTarget.scenario?.id || null,
        testCaseId: guidanceTarget.case?.id || null,
        instruction,
        quickIntents,
        subject,
      });
      const guidanceId = guidanceRes.guidance?.id;
      if (guidanceTarget.scope === 'suite') {
        setGuidanceTarget(null);
        await handleGenerate(null, true, { guidanceId });
      } else if (guidanceTarget.scope === 'scenario') {
        setGuidanceTarget(null);
        await handleRegenerateScenario(guidanceTarget.scenario, guidanceId, 'refine', targetOperationId);
      } else if (guidanceTarget.scope === 'case') {
        const tc = guidanceTarget.case;
        const operationId = targetOperationId || makeAuthoringOperationId('case', tc.id);
        const refine = await api.post(`/projects/${current.id}/test-cases/${tc.id}/refine`, { guidanceId, operationId });
        patchOperationSnapshot(current.id, 'caseOps', tc.id, { type: 'refine', status: 'done', progress: 100 });
        toast.success(`Updated "${(refine.testCase?.name || tc.name).slice(0, 60)}". Review it before approving.`, {
          title: 'Case refined',
        });
        setGuidanceTarget(null);
        await load();
      }
    } catch (err) {
      if (guidanceTarget?.scope === 'case' && guidanceTarget.case?.id) {
        patchOperationSnapshot(current.id, 'caseOps', guidanceTarget.case.id, { type: 'refine', status: 'error', progress: 100 });
      }
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Guidance failed' });
    } finally {
      setGuidanceSubmitting(false);
    }
  }, [current, currentSprintId, currentGenerationId, guidanceTarget, handleGenerate, handleRegenerateScenario, load, toast]);

  // ── Cmd+K ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  // ── Derived counts ──────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const allCases = tabSourceScenarios.flatMap((s) => s.cases);
    const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const s of tabSourceScenarios) byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
    const pending  = allCases.filter((t) => t.status === 'pending').length;
    const rejected = allCases.filter((t) => t.status === 'rejected').length;
    const running  = allCases.filter((t) => t.status === 'running').length;
    // CRIT-6: 'running' is a transient sub-state of 'approved' (the user
    // approved the case; it's just currently being executed). Counting them
    // together keeps the approval count stable through the run lifecycle —
    // "17 approved" stays "17 approved" before, during, and after execution.
    const approved = allCases.filter((t) => t.status === 'approved' || t.status === 'running').length;
    const runReady = allCases.filter((t) => (t.status === 'approved' || t.status === 'running') && isCaseRunEligible(t)).length;
    const approvedBlocked = Math.max(0, approved - runReady);
    const pass     = allCases.filter((t) => t.latestResult?.status === 'pass').length;
    const fail     = allCases.filter((t) => t.latestResult?.status === 'fail').length;
    const blocked  = allCases.filter((t) => t.latestResult?.status === 'blocked').length;
    const skipped  = allCases.filter((t) => t.latestResult?.status === 'skipped').length;
    return {
      scenarios: tabSourceScenarios.length, total: allCases.length,
      pending, approved, runReady, approvedBlocked, rejected, running,
      pass, fail, blocked, skipped, byPriority,
    };
  }, [tabSourceScenarios]);

  // ── Visible scenarios after filters ─────────────────────────────────────
  const matchesStatusFilter = useCallback(
    (c) => {
      if (!statusFilter) return true;
      if (statusFilter === 'pass') return c.latestResult?.status === 'pass';
      if (statusFilter === 'fail') return c.latestResult?.status === 'fail';
      if (statusFilter === 'blocked') return c.latestResult?.status === 'blocked';
      if (statusFilter === 'skipped') return c.latestResult?.status === 'skipped';
      return c.status === statusFilter;
    },
    [statusFilter]
  );

  const matchesConfidence = useCallback(
    (c) => !confidenceMin || (typeof c.confidence === 'number' && c.confidence >= confidenceMin),
    [confidenceMin]
  );

  const matchesSearch = useCallback(
    (c) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return (c.name || '').toLowerCase().includes(q) || (c.assertions || '').toLowerCase().includes(q);
    },
    [searchQuery]
  );

  const visibleScenarios = useMemo(() => {
    let list = tabSourceScenarios;
    if (moduleParam) list = list.filter((s) => s.module === moduleParam);
    if (filter !== 'all') {
      if (['P0', 'P1', 'P2', 'P3'].includes(filter)) list = list.filter((s) => s.priority === filter);
      else list = list.filter((s) => s.category === filter);
    }
    const narrowsCases = statusFilter || confidenceMin || searchQuery.trim();
    if (narrowsCases) {
      list = list
        .map((s) => ({
          ...s,
          cases: s.cases.filter((c) => matchesStatusFilter(c) && matchesConfidence(c) && matchesSearch(c)),
        }))
        .filter((s) => s.cases.length > 0);
    }
    return list;
  }, [tabSourceScenarios, moduleParam, filter, statusFilter, confidenceMin, searchQuery, matchesStatusFilter, matchesConfidence, matchesSearch]);

  const allVisibleCaseIds = useMemo(
    () => visibleScenarios.flatMap((s) => s.cases.map((c) => c.id)),
    [visibleScenarios]
  );
  const visibleRenderedCaseCount = allVisibleCaseIds.length;
  const visibleExpandedCount = useMemo(
    () => visibleScenarios.filter((s) => expanded.has(s.id)).length,
    [visibleScenarios, expanded]
  );
  const activeFilterCount = useMemo(() => {
    return [
      filter !== 'all',
      !!statusFilter,
      !!confidenceMin,
      !!searchQuery.trim(),
      !!moduleParam,
    ].filter(Boolean).length;
  }, [filter, statusFilter, confidenceMin, searchQuery, moduleParam]);

  const toggleStatusFilter = useCallback(
    (s) => setStatusFilter((cur) => (cur === s ? null : s)),
    []
  );

  const toggleExpanded = (id) => {
    setHoverScenarioId((cur) => (cur === id ? null : cur));
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const expandVisibleScenarios = useCallback(
    () => {
      setHoverScenarioId(null);
      setExpanded(new Set(visibleScenarios.map((s) => s.id)));
    },
    [visibleScenarios]
  );
  const collapseVisibleScenarios = useCallback(() => {
    setHoverScenarioId(null);
    setExpanded(new Set());
  }, []);

  // ── Run cost estimate ───────────────────────────────────────────────────
  const runCostEstimate = useMemo(() => {
    const approved = approvedAutomationCases(tabSourceScenarios);
    if (approved.length === 0) return null;
    const oneAttemptTexts = approved.map(() => 'x'.repeat(800 * 4));
    const lo = estimateArchitectCost(oneAttemptTexts);
    const hi = estimateArchitectCost(oneAttemptTexts.flatMap(() => ['x'.repeat(800 * 4 * 3)]));
    return {
      count: approved.length,
      lowUsd: lo.costUsd, highUsd: hi.costUsd,
      seconds: 30 + approved.length * 6,
    };
  }, [tabSourceScenarios]);

  // ── Derived counts for filter rail confidence column ────────────────────
  // These should reflect "after applying the priority/type/module filter" so
  // the user's count badge doesn't lie about what's left when they layer
  // confidence on top of an already-narrowed list.
  const baseListForConfidenceCount = useMemo(() => {
    let list = tabSourceScenarios;
    if (moduleParam) list = list.filter((s) => s.module === moduleParam);
    if (filter !== 'all') {
      if (['P0', 'P1', 'P2', 'P3'].includes(filter)) list = list.filter((s) => s.priority === filter);
      else list = list.filter((s) => s.category === filter);
    }
    return list;
  }, [tabSourceScenarios, moduleParam, filter]);
  const visibleCaseCount = baseListForConfidenceCount.reduce((a, s) => a + s.cases.length, 0);
  const hiConfCount80 = baseListForConfidenceCount.flatMap((s) => s.cases).filter((c) => (c.confidence ?? 0) >= 80).length;
  const hiConfCount90 = baseListForConfidenceCount.flatMap((s) => s.cases).filter((c) => (c.confidence ?? 0) >= 90).length;

  const canRun = !executing && !running && counts.approved > 0;
  const hasImpacted = scenarios.some((s) => s.impacted);
  const activeScenarioOperation = useMemo(() => {
    const runningOp = Object.values(scenarioOps).find((op) => op?.status === 'running');
    if (runningOp) return runningOp;
    return null;
  }, [scenarioOps]);

  // Empty-state — no project yet
  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <EmptyState illustration="project" title="No project selected" message="Create or activate a project first." />
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
    <div className="flex flex-col h-full overflow-hidden">
      <main
        ref={mainScrollRef}
        className="flex-1 overflow-y-auto relative"
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* Sticky aurora layer — same dvh-trick as Overview/RunSuite */}
        <div
          className="sticky top-0 overflow-hidden pointer-events-none"
          style={{ height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
          aria-hidden="true"
        >
          <AuroraSoft />
        </div>

        <div className="relative z-10 max-w-6xl mx-auto px-page py-8 space-y-5">
          <TestInventoryToolbar
            scenariosCount={scenarios.length}
            automationCount={automationCasesTotal}
            manualCount={manualCasesTotal}
            manualCompleted={manualCasesCompleted}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onConfigureTrigger={() => setTriggerModalOpen(true)}
            onNewBatch={() => setShowNewBatch(true)}
            onAddScenario={() => setShowAddScenario(true)}
            onRefine={() => setGuidanceTarget({ scope: 'suite' })}
            onToggleBulk={() => { setBulkMode((on) => !on); clearBulk(); }}
            bulkMode={bulkMode}
            actionsDisabled={generating || guidanceSubmitting}
            headlessMode={headlessMode}
            headlessSaving={headlessSaving}
            onToggleHeadless={handleToggleHeadless}
          />

          {/* Smoke-picker action bar — only visible while the user has cases
              in their smoke set. Sticks to the top of the scroll container
              so a 50-row test list doesn't hide the launch button after
              scrolling. Glass + info palette so it doesn't compete with the
              Approval Hero's Aurora gradients. */}
          {automationTab === 'automation' && smokeIds.size > 0 && (
            <div
              className="sticky top-2 z-20 rounded-card border border-info-200 bg-white/85 backdrop-blur-md shadow-card px-4 py-2.5 flex items-center gap-3"
              role="region"
              aria-label="Smoke selection"
            >
              <Target className="w-4 h-4 text-info-700 shrink-0" aria-hidden="true" />
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold text-ink-900 tabular-nums">{smokeIds.size}</span>
                <span className="text-xs text-ink-600">case{smokeIds.size === 1 ? '' : 's'} in smoke set</span>
              </div>
              <span className="text-xs text-ink-400 hidden sm:inline">·</span>
              <span className="text-xs text-ink-500 hidden sm:inline truncate">
                Cherry-picked re-run without burning the full suite budget.
              </span>
              <div className="ml-auto inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={clearSmoke}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-pill text-xs font-semibold text-ink-600 bg-white/70 border border-ink-200 hover:bg-white hover:text-ink-900 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  Clear
                </button>
                <button
                  type="button"
                  onClick={handleRunSmoke}
                  disabled={runningSmoke || running}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-pill text-xs font-bold text-white bg-info-600 hover:bg-info-700 disabled:bg-ink-300 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  {runningSmoke ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Zap className="w-3.5 h-3.5 fill-current" />
                  )}
                  Run smoke ({smokeIds.size})
                </button>
              </div>
            </div>
          )}

          {showNewBatch ? (
            // New-batch flow — re-opened config card replaces the list. Routes to
            // handleGenerateNewBatch (replace:true → a new generation). The header
            // version selector keeps the current batch reachable while this is open.
            <GenerateConfigCard
              projectId={current?.id}
              onGenerate={handleGenerateNewBatch}
              onCancel={() => setShowNewBatch(false)}
              generating={generating || (architectPhaseRunning && !regenScenarioId)}
            />
          ) : (loading && scenarios.length === 0) ? (
            <TestCasesSkeleton />
          ) : (
            <>
              {/* Hero — only when scenarios exist. Hides when the page shows
                  GenerateConfigCard or NoDocumentsState (counts.total === 0)
                  so the two empty-state UIs don't stack on top of each other. */}
              {automationTab === 'automation' && counts.total > 0 && (
                <ApprovalHero
                  counts={counts}
                  runCostEstimate={runCostEstimate}
                  executing={executing}
                  canRun={canRun}
                  generating={generating || (architectPhaseRunning && !regenScenarioId)}
                  running={running}
                  architectProgress={architectProgress}
                  selecting={selecting}
                  approving={approving}
                  hasImpacted={hasImpacted}
                  impactedPendingCount={impactedPending.length}
                  hasRuns={hasRuns}
                  scenarioOperation={activeScenarioOperation}
                  onGenerate={handleGenerate}
                  onSmartSelect={handleSmartSelect}
                  onApproveAll={handleApproveAll}
                  onApproveImpacted={handleApproveImpactedOnly}
                  onExecute={handleExecute}
                />
              )}

              {/* Inline phase banner */}
              <AnimatePresence>
                {activePhase && phaseStatus !== 'idle' && !(activeScenarioOperation?.status === 'running' && activePhase === 'architect') && (
                  <PhaseBanner
                    phase={activePhase}
                    status={phaseStatus}
                    log={phaseLog}
                    elapsed={phaseElapsed}
                    onTerminate={handleTerminate}
                    onDismiss={() => setActivePhase(null)}
                  />
                )}
              </AnimatePresence>

              {/* Just-generated welcome */}
              <AnimatePresence>
                {justGenerated && counts.total > 0 && (
                  <JustGeneratedBanner
                    counts={counts}
                    scenarios={scenarios}
                    approving={approving}
                    onApproveAll={handleApproveAll}
                    onDismiss={() => setSearchParams((s) => {
                      const n = new URLSearchParams(s);
                      n.delete('just');
                      return n;
                    })}
                  />
                )}
              </AnimatePresence>

              {/* Module deep-link banner */}
              <AnimatePresence>
                {moduleParam && counts.total > 0 && (
                  <ModuleBanner
                    moduleName={moduleParam}
                    count={visibleScenarios.length}
                    onClear={() => setSearchParams((s) => {
                      const next = new URLSearchParams(s);
                      next.delete('module');
                      return next;
                    }, { replace: true })}
                  />
                )}
              </AnimatePresence>

              {/* Automation / Manual tabs — only shown when there are scenarios.
                  "Automation 0 / Manual 0" above the config card is noise. */}
              {counts.total > 0 && <AutomationManualTabs
                current={automationTab}
                onChange={setAutomationTab}
                automationCount={automationCasesTotal}
                manualCount={manualCasesTotal}
                manualCompleted={manualCasesCompleted}
              />}

              {automationTab === 'automation' && (
                <>
                  {/* Execution strip — filter triggers */}
                  <ExecutionStrip
                    counts={counts}
                    statusFilter={statusFilter}
                    onToggleStatus={toggleStatusFilter}
                  />
                </>
              )}

              {/* Bulk action bar */}
              <AnimatePresence>
                {bulkMode && counts.total > 0 && (
                  <BulkBar
                    selectedCount={bulkIds.size}
                    totalVisible={allVisibleCaseIds.length}
                    onSelectAll={() => setBulkIds(new Set(allVisibleCaseIds))}
                    onClear={clearBulk}
                    onApprove={() => bulkUpdateStatus('approved')}
                    onReject={() => bulkUpdateStatus('rejected')}
                    onRemove={bulkDelete}
                    onDone={exitBulk}
                  />
                )}
              </AnimatePresence>

              {/* Filter rail — automation tab only. Manual cases use their
                  own list view without confidence / priority filters. */}
              {automationTab === 'automation' && (
                <FilterRail
                  counts={counts}
                  scenarios={tabSourceScenarios}
                  filter={filter}
                  setFilter={setFilter}
                  confidenceMin={confidenceMin}
                  setConfidenceMin={setConfidenceMin}
                  visibleCaseCount={visibleCaseCount}
                  hiConfCount80={hiConfCount80}
                  hiConfCount90={hiConfCount90}
                  onClearAll={() => { setFilter('all'); setConfidenceMin(null); setSearchQuery(''); }}
                />
              )}

              {/* Scenarios — layout-animated list (Automation tab) or
                  manual checklist (Manual tab). */}
              {automationTab === 'automation' && counts.total > 0 && (
                <ReviewListToolbar
                  visibleScenarioCount={visibleScenarios.length}
                  visibleCaseCount={visibleRenderedCaseCount}
                  totalCaseCount={counts.total}
                  expandedCount={visibleExpandedCount}
                  activeFilterCount={activeFilterCount}
                  onExpandAll={expandVisibleScenarios}
                  onCollapseAll={collapseVisibleScenarios}
                />
              )}

              {automationTab === 'manual' ? (
                <ManualPanel
                  manualScenarios={manualScenarios}
                  loading={loading}
                  onReload={load}
                />
              ) : counts.total === 0 ? (
                reqCount === 0 ? (
                  <NoDocumentsState />
                ) : (
                  <GenerateConfigCard
                    projectId={current?.id}
                    onGenerate={handleGenerate}
                    generating={generating || (architectPhaseRunning && !regenScenarioId)}
                  />
                )
              ) : visibleScenarios.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4 }}
                  className="glass-soft p-8 text-center"
                >
                  <FileText className="w-6 h-6 mx-auto mb-2 text-ink-300" />
                  <p className="text-sm font-semibold text-ink-900">No matches</p>
                  <p className="text-xs text-ink-500 mt-1">Adjust the filter above or clear it to see all cases.</p>
                </motion.div>
              ) : (
                <LayoutGroup>
                  <section className="space-y-3">
                    {visibleScenarios.map((s, i) => (
                      <ScenarioCard
                        key={s.id}
                        scenario={s}
                        index={i}
                        expanded={expanded.has(s.id)}
                        onToggle={() => toggleExpanded(s.id)}
                        onApproveCase={(tc) => setStatus(tc, 'approved')}
                        onRejectCase={(tc) => setStatus(tc, 'rejected')}
                        refMap={scenarioRefs}
                        bulkMode={bulkMode}
                        bulkIds={bulkIds}
                        onToggleBulk={toggleBulk}
                        onRegenerate={() => handleRegenerateScenario(s)}
                        regenerating={regenScenarioId === s.id}
                        operation={scenarioOps[s.id]}
                        onRefineScenario={(scenario) => setGuidanceTarget({ scope: 'scenario', scenario })}
                        onRefineCase={(scenario, tc) => setGuidanceTarget({ scope: 'case', scenario, case: tc })}
                        onRestoreScenario={handleRestoreScenario}
                        onRestoreCase={handleRestoreCase}
                        onDeleteScenario={handleDeleteScenario}
                        deleting={deleteScenarioId === s.id}
                        stepStatusByTc={stepStatusByTc}
                        smokeIds={smokeIds}
                        onToggleSmoke={toggleSmoke}
                        caseOperations={caseOps}
                        activeHoverScenarioId={hoverScenarioId}
                        onHoverScenario={setHoverScenarioId}
                        onAddStep={handleAddStep}
                        onSaveStep={handleSaveStep}
                        onRemoveStep={handleRemoveStep}
                        onReorderSteps={handleReorderSteps}
                        onUndoStep={handleUndoStep}
                      />
                    ))}
                  </section>
                </LayoutGroup>
              )}

              {/* Footnote — only when there's content + the user is in review mode */}
              {automationTab === 'automation' && counts.total > 0 && counts.approved < counts.total && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4, duration: 0.5 }}
                  className="flex items-center justify-center gap-2 py-4 text-2xs text-ink-500"
                >
                  <ShieldCheck className="w-3 h-3" />
                  <span>
                    Approved cases enter live execution. Readiness warnings are advisory; reject what you don't trust.
                  </span>
                </motion.div>
              )}
            </>
          )}
        </div>
      </main>

      {/* Cmd+K search modal */}
      <AnimatePresence>
        {searchOpen && (
          <SearchModal
            scenarios={scenarios}
            onClose={() => setSearchOpen(false)}
            onPick={(scenarioId) => {
              setSearchOpen(false);
              setExpanded((prev) => {
                const next = new Set(prev);
                next.add(scenarioId);
                return next;
              });
              requestAnimationFrame(() => {
                const node = scenarioRefs.current.get(scenarioId);
                if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
              });
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {triggerModalOpen && (
          <TriggerConfigModal
            open={triggerModalOpen}
            draft={triggerDraft}
            setDraft={setTriggerDraft}
            fixtures={authFixtures}
            approvedCount={counts.approved}
            smokeCount={smokeIds.size}
            loading={triggerLoading}
            saving={triggerSaving}
            onClose={() => triggerSaving ? null : setTriggerModalOpen(false)}
            onSave={saveTriggerSettings}
            onRunNow={saveTriggerAndRun}
          />
        )}
        {showAddScenario && (
          <AddScenarioModal
            open={showAddScenario}
            submitting={addScenarioSubmitting}
            interpreting={interpretationSubmitting}
            scenarios={scenarios}
            onClose={() => setShowAddScenario(false)}
            onSubmit={handleAddScenario}
            onInterpret={handleInterpretAddScenario}
          />
        )}
        {interpretationPreview && (
          <InterpretationPreviewModal
            preview={interpretationPreview}
            refining={interpretationRefining}
            approving={interpretationApproving}
            onClose={() => {
              if (!interpretationRefining && !interpretationApproving) setInterpretationPreview(null);
            }}
            onRefine={handleRefineInterpretationPreview}
            onApprove={handleApproveInterpretationPreview}
            onContinue={handleContinueDeterministicPreview}
          />
        )}
        {addScenarioPreview && (
          <AddScenarioPreviewModal
            preview={addScenarioPreview}
            refining={previewRefining}
            approving={previewApproving}
            onDiscard={handleDiscardAddScenarioPreview}
            onRefine={handleRefineAddScenarioPreview}
            onApprove={handleApproveAddScenarioPreview}
          />
        )}
      </AnimatePresence>

      <GenerationGuidancePanel
        open={!!guidanceTarget}
        title={
          guidanceTarget?.scope === 'case'
            ? 'Improve this test case'
            : guidanceTarget?.scope === 'scenario'
              ? 'Refine this scenario'
              : 'Refine the test suite'
        }
        subtitle={
          guidanceTarget?.scope === 'case'
            ? 'Tell QAAI what to add or fix in this one case. This same row will be updated, marked improved, and returned to pending review.'
            : guidanceTarget?.scope === 'scenario'
              ? 'Give focused direction, then QAAI will regenerate this scenario in the current generation.'
              : 'Give suite-level direction. QAAI will create a new generation and keep the current one in history.'
        }
        placeholder={
          guidanceTarget?.scope === 'case'
            ? 'Example: Keep the current steps, use the uploaded AuthProfiles data, insert a validation after login, and add a final URL assertion for the expected landing page.'
            : guidanceTarget?.scope === 'scenario'
              ? 'Example: Keep the core scenario, add negative paths from uploaded data, and strengthen assertions without changing the business outcome.'
              : undefined
        }
        subject={
          guidanceTarget?.scope === 'case'
            ? guidanceTarget?.case?.name
            : guidanceTarget?.scope === 'scenario'
              ? guidanceTarget?.scenario?.name
              : current?.name
        }
        submitLabel={
          guidanceTarget?.scope === 'case'
            ? 'Refine case'
            : guidanceTarget?.scope === 'scenario'
              ? 'Regenerate scenario'
              : 'Create refined generation'
        }
        loading={guidanceSubmitting}
        onClose={() => guidanceSubmitting ? null : setGuidanceTarget(null)}
        onSubmit={handleSubmitGuidance}
      />
    </div>
    </MotionConfig>
  );
}

function TestCasesSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="glass p-9 grid lg:grid-cols-[240px_1fr_auto] gap-8 items-center">
        <Skeleton className="h-44 w-44 mx-auto" rounded="pill" />
        <div className="space-y-3">
          <Skeleton className="h-3 w-40" rounded="pill" />
          <Skeleton className="h-16 w-72" />
          <Skeleton className="h-3 w-3/4" />
          <div className="flex gap-2 flex-wrap">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-28" rounded="pill" />)}
          </div>
        </div>
        <Skeleton className="h-28 w-48" rounded="2xl" />
      </div>
      <Skeleton className="h-12 w-full" rounded="2xl" />
      <Skeleton className="h-32 w-full" rounded="2xl" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="glass p-6 space-y-3">
            <Skeleton className="h-3 w-32" rounded="pill" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}
