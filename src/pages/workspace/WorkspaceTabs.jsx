import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import {
  AlertCircle,
  Activity,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Fingerprint,
  FileSpreadsheet,
  Folder,
  GitBranch,
  Globe2,
  KeyRound,
  Mail,
  MousePointerClick,
  Plug,
  RefreshCw,
  Route,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Target,
  TestTube2,
  TextCursorInput,
  Webhook,
  X,
  XCircle,
} from 'lucide-react';
import api from '../../lib/apiClient';
import { useToast } from '../../lib/useToast';
import Skeleton from '../../components/ui/Skeleton';
import Reports from '../Reports';
import TestCases from '../TestCases';
import Theater from '../Theater';
import OutputFiles from '../OutputFiles';
import BlockedItems from '../BlockedItems';

function Panel({ title, subtitle, children, action }) {
  return (
    <section className="rounded-lg border border-ink-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-ink-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink-950">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function EmptyPanel({ icon: Icon, title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50 p-10 text-center">
      <Icon className="mx-auto h-8 w-8 text-ink-400" aria-hidden="true" />
      <h3 className="mt-4 text-base font-semibold text-ink-950">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-500">{children}</p>
    </div>
  );
}

function WorkspacePage({ children }) {
  return (
    <div className="h-full overflow-auto px-page py-6">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-5">{children}</div>
    </div>
  );
}

export function WorkspaceResults() {
  return <Reports />;
}

export function WorkspaceTests() {
  return <TestCases />;
}

export function WorkspaceLive() {
  return <Theater />;
}

export function WorkspaceOutputFiles() {
  return <OutputFiles />;
}

export function WorkspaceRecovery() {
  return <BlockedItems />;
}

export function WorkspaceTestAccounts() {
  const { projectId } = useParams();
  const [profiles, setProfiles] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [profilesRes, fixturesRes] = await Promise.all([
          api.get(`/projects/${projectId}/auth-profiles`).catch(() => ({ authProfiles: [] })),
          api.get(`/projects/${projectId}/auth-fixtures`).catch(() => []),
        ]);
        if (!cancelled) {
          setProfiles(profilesRes?.authProfiles || profilesRes?.profiles || []);
          setFixtures(Array.isArray(fixturesRes) ? fixturesRes : fixturesRes?.fixtures || []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <WorkspacePage>
      <Panel
        title="Test Accounts"
        subtitle="Credentials, auth profiles, and saved browser sessions used by execution, Atlas, and repair."
        action={
          <Link to="/project-setup" className="inline-flex h-9 items-center gap-2 rounded-md bg-ink-950 px-3 text-sm font-semibold text-white">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Configure
          </Link>
        }
      >
        {loading ? (
          <div className="text-sm text-ink-500">Loading account data...</div>
        ) : profiles.length === 0 && fixtures.length === 0 ? (
          <EmptyPanel icon={KeyRound} title="No reusable accounts yet">
            Add credentials or a saved session so live runs, DOM Atlas, and evidence repair can enter protected areas without blind probing.
          </EmptyPanel>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-lg border border-ink-200">
              <div className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-800">Auth profiles</div>
              {profiles.length === 0 ? (
                <div className="p-4 text-sm text-ink-500">No auth profiles configured.</div>
              ) : profiles.map((profile) => (
                <div key={profile.id} className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink-900">{profile.name || profile.label || 'Auth profile'}</div>
                    <div className="text-xs text-ink-500">{profile.strategy || profile.type || 'custom'}</div>
                  </div>
                  <span className="rounded-full bg-success-50 px-2 py-1 text-xs font-medium text-success-700">available</span>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-ink-200">
              <div className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-800">Saved sessions</div>
              {fixtures.length === 0 ? (
                <div className="p-4 text-sm text-ink-500">No storage-state fixtures saved.</div>
              ) : fixtures.map((fixture) => (
                <div key={fixture.id} className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink-900">{fixture.name || fixture.label || 'Saved session'}</div>
                    <div className="text-xs text-ink-500">{fixture.status || fixture.disposition || 'ready'}</div>
                  </div>
                  <CheckCircle2 className="h-4 w-4 text-success-600" aria-hidden="true" />
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </WorkspacePage>
  );
}

const MEMORY_TRUST_META = {
  trusted: {
    label: 'Trusted',
    detail: 'Reused before model reasoning',
    badgeClass: 'border-success-200 bg-success-50 text-success-700',
    dotClass: 'bg-success-500',
  },
  candidate: {
    label: 'Observed',
    detail: 'Captured, waiting for more proof',
    badgeClass: 'border-info-100 bg-info-50 text-info-700',
    dotClass: 'bg-info-500',
  },
  degraded: {
    label: 'Drifted',
    detail: 'Failures reduced confidence',
    badgeClass: 'border-warn-200 bg-warn-50 text-warn-800',
    dotClass: 'bg-warn-500',
  },
  quarantined: {
    label: 'Quarantined',
    detail: 'Not reused until repaired',
    badgeClass: 'border-danger-200 bg-danger-50 text-danger-700',
    dotClass: 'bg-danger-500',
  },
  unknown: {
    label: 'Unknown',
    detail: 'State has not been classified',
    badgeClass: 'border-ink-200 bg-ink-50 text-ink-600',
    dotClass: 'bg-ink-400',
  },
};

const ACTION_ICON_BY_TYPE = {
  click: MousePointerClick,
  double_click: MousePointerClick,
  fill: TextCursorInput,
  type: TextCursorInput,
  select: Target,
  assert: ShieldCheck,
  assertion: ShieldCheck,
  evaluate: ShieldCheck,
  hover: MousePointerClick,
};

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function firstText(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function shortId(value) {
  const text = firstText(value);
  if (!text) return '';
  return text.length <= 10 ? text : `${text.slice(0, 8)}...`;
}

function shortMemoryUrl(value) {
  const text = firstText(value);
  if (!text) return '';
  return text.replace(/^https?:\/\//i, '').replace(/\/$/, '') || text;
}

function formatMemoryDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeActionType(value) {
  const raw = firstText(value, 'action');
  return raw.replace(/^browser_/, '').replace(/_/g, ' ');
}

function getMemoryTrust(memory) {
  const state = firstText(memory?.trustState, 'unknown').toLowerCase();
  return MEMORY_TRUST_META[state] ? state : 'unknown';
}

function getMemoryRoute(memory) {
  const context = safeJson(memory.contextJson, {});
  const facts = safeJson(memory.targetFactsJson, {});
  const route = firstText(memory.routeKey, context.routeKey, facts.routeKey);
  const url = firstText(memory.pageUrl, context.pageUrl, facts.pageUrl, facts.url);
  return {
    key: route || url || 'Unscoped page',
    url,
    label: route || shortMemoryUrl(url) || 'Unscoped page',
  };
}

function getMemoryLocatorExpression(memory) {
  const framework = safeJson(memory.frameworkExpressionsJson, {});
  const locator = safeJson(memory.actionLocatorJson, {});
  const expressions = locator.frameworkExpressions || {};
  return firstText(
    framework.playwright,
    framework.expression,
    expressions.playwright,
    locator.primaryExpression,
    locator.locatorExpression,
    locator.selector,
    memory.selectorExpression,
  );
}

function getMemoryFingerprint(memory) {
  const locator = safeJson(memory.actionLocatorJson, {});
  const context = safeJson(memory.contextJson, {});
  const fingerprint = locator.locatorFingerprint || locator.fingerprint || context.locatorFingerprint || context.fingerprint || null;
  if (!fingerprint || typeof fingerprint !== 'object') return null;
  return fingerprint;
}

function fingerprintLabel(fingerprint) {
  const hash = firstText(fingerprint?.hash);
  if (!hash) return 'No fingerprint';
  return hash.length > 12 ? `${hash.slice(0, 10)}...` : hash;
}

function fingerprintIdentityLine(fingerprint) {
  const semantic = fingerprint?.semantic || {};
  const structural = fingerprint?.structural || {};
  return firstText(
    [semantic.role, semantic.accessibleName || semantic.placeholder || semantic.label || semantic.testId].filter(Boolean).join(' / '),
    structural.frameSelector ? `frame ${structural.frameSelector}` : '',
    structural.shadowHostSelector ? `shadow ${structural.shadowHostSelector}` : '',
    'Identity anchors unavailable',
  );
}

function getMemoryFacts(memory) {
  const facts = safeJson(memory.targetFactsJson, {});
  const locator = safeJson(memory.actionLocatorJson, {});
  const metadata = locator.metadata || {};
  const proof = locator.proof || {};
  const attrs = facts.attributes || facts.attrs || {};
  const rows = [
    ['role', firstText(facts.role, metadata.role, locator.role)],
    ['name', firstText(facts.accessibleName, facts.name, metadata.normalizedAccessibleName, metadata.accessibleName, memory.elementLabel)],
    ['label', firstText(facts.label, facts.labelText, facts.associatedLabel, metadata.label)],
    ['placeholder', firstText(facts.placeholder, attrs.placeholder, metadata.placeholder)],
    ['test id', firstText(facts.testId, facts.testid, attrs['data-testid'], attrs['data-test'], metadata.testId)],
    ['tag', firstText(facts.tagName, facts.tag, metadata.tagName)],
    ['strategy', firstText(locator.strategy, metadata.strategy, facts.strategy)],
  ];
  if (proof.uniquenessCount != null) rows.push(['unique', `${proof.uniquenessCount} match${proof.uniquenessCount === 1 ? '' : 'es'}`]);
  if (proof.isVisible === true) rows.push(['proof', 'visible']);
  if (proof.isEnabled === true) rows.push(['state', 'enabled']);
  return rows
    .filter(([, value]) => firstText(value))
    .slice(0, 8)
    .map(([label, value]) => ({ label, value: String(value) }));
}

function getMemoryTitle(memory) {
  const facts = getMemoryFacts(memory);
  const factName = facts.find((fact) => ['name', 'label', 'placeholder', 'test id'].includes(fact.label))?.value;
  return firstText(memory.elementLabel, factName, memory.elementKey, memory.stepIntentHash, 'Recorded action');
}

function getMemorySourceLine(memory) {
  const source = memory.source || {};
  const testCase = source.testCase?.name;
  const scenario = source.scenario?.name;
  const dataRow = firstText(source.runResult?.dataRowLabel, source.runResult?.dataSetName);
  const module = firstText(memory.module, source.scenario?.module, source.testCase?.module);
  const pieces = [module, scenario, testCase, dataRow].filter(Boolean);
  if (pieces.length) return pieces.join(' - ');
  return firstText(
    memory.testCaseId ? `Test ${shortId(memory.testCaseId)}` : '',
    memory.lastRunId ? `Run ${shortId(memory.lastRunId)}` : '',
    '',
  );
}

function buildMemorySearchText(memory) {
  const source = memory.source || {};
  return [
    memory.actionType,
    memory.toolName,
    memory.elementLabel,
    memory.elementKey,
    memory.trustState,
    memory.stepIntentHash,
    memory.routeKey,
    memory.pageUrl,
    source.testCase?.name,
    source.scenario?.name,
    getMemoryLocatorExpression(memory),
    getMemoryFingerprint(memory)?.hash,
    ...getMemoryFacts(memory).flatMap((fact) => [fact.label, fact.value]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function MemoryAuroraBackground() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div className="aurora-orb aurora-orb-info aurora-drift-1" style={{ width: 440, height: 440, left: '-8%', top: '-12%' }} />
      <div className="aurora-orb aurora-orb-accent aurora-drift-2" style={{ width: 520, height: 520, right: '-12%', top: '4%' }} />
      <div className="aurora-orb aurora-orb-success aurora-drift-3" style={{ width: 420, height: 420, left: '28%', bottom: '-18%' }} />
      <div className="aurora-orb aurora-orb-warn aurora-drift-2" style={{ width: 300, height: 300, right: '22%', bottom: '8%', opacity: 0.28 }} />
    </div>
  );
}

function MemoryStat({ icon: Icon, label, value, tone = 'ink' }) {
  const toneClass = {
    success: 'text-success-800',
    info: 'text-info-800',
    warn: 'text-warn-900',
    danger: 'text-danger-800',
    ink: 'text-ink-800',
  }[tone] || 'text-ink-800';
  const iconClass = {
    success: 'bg-success-100 text-success-700',
    info: 'bg-info-100 text-info-700',
    warn: 'bg-warn-100 text-warn-800',
    danger: 'bg-danger-100 text-danger-700',
    ink: 'bg-ink-100 text-ink-700',
  }[tone] || 'bg-ink-100 text-ink-700';

  return (
    <div className={`flex min-w-[150px] items-center gap-3 rounded-2xl border border-white/60 bg-white/45 px-3 py-2 shadow-sm backdrop-blur ${toneClass}`}>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl shadow-sm ${iconClass}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-xl font-semibold leading-none tabular-nums">{value}</div>
        <div className="mt-0.5 truncate text-[11px] font-semibold uppercase tracking-wide opacity-70">{label}</div>
      </div>
    </div>
  );
}

function MemoryCoverageGauge({ value }) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  const needleAngle = `${-90 + (clamped / 100) * 180}deg`;
  const polarPoint = (radius, angle) => {
    const radians = (angle * Math.PI) / 180;
    return {
      x: 80 + radius * Math.cos(radians),
      y: 90 - radius * Math.sin(radians),
    };
  };
  const annularSegment = (startAngle, endAngle, outerRadius = 60, innerRadius = 33) => {
    const outerStart = polarPoint(outerRadius, startAngle);
    const outerEnd = polarPoint(outerRadius, endAngle);
    const innerEnd = polarPoint(innerRadius, endAngle);
    const innerStart = polarPoint(innerRadius, startAngle);
    const largeArc = Math.abs(startAngle - endAngle) > 180 ? 1 : 0;
    return [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      `L ${innerEnd.x} ${innerEnd.y}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
      'Z',
    ].join(' ');
  };
  const fillEndAngle = 180 - (clamped / 100) * 180;
  const trackPath = annularSegment(180, 0);
  const fillPath = annularSegment(180, fillEndAngle);

  return (
    <div className="flex items-center gap-5">
      <div className="relative h-[120px] w-[178px]" aria-hidden="true">
        <svg
          viewBox="0 0 160 120"
          className="h-full w-full overflow-visible"
          style={{ '--needle-angle': needleAngle }}
        >
          <defs>
            <linearGradient id="memoryGaugeFill" x1="20" y1="90" x2="140" y2="90" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#10b981" />
              <stop offset="0.52" stopColor="#2dd4bf" />
              <stop offset="1" stopColor="#34d399" />
            </linearGradient>
            <linearGradient id="memoryGaugeSweep" x1="20" y1="90" x2="140" y2="90" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="rgba(255,255,255,0)" />
              <stop offset="0.5" stopColor="rgba(236,253,245,0.62)" />
              <stop offset="1" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
            <filter id="memoryGaugeShadow" x="-20%" y="-20%" width="140%" height="150%">
              <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#0f172a" floodOpacity="0.12" />
            </filter>
          </defs>
          <path
            d={trackPath}
            fill="rgba(15,23,42,0.10)"
          />
          <path
            d={fillPath}
            fill="url(#memoryGaugeFill)"
            className="memory-gauge-fill"
            filter="url(#memoryGaugeShadow)"
          />
          <path
            d={fillPath}
            fill="url(#memoryGaugeSweep)"
            className="memory-gauge-sweep"
          />
          <path
            d="M47 90a33 33 0 0 1 66 0"
            fill="none"
            stroke="rgba(255,255,255,0.72)"
            strokeWidth="24"
            strokeLinecap="butt"
          />
          <g className="memory-gauge-needle">
            <path d="M77.5 89 L80 28 L82.5 89 Z" fill="#1f2937" />
            <path d="M80 35 L81 87" stroke="rgba(255,255,255,0.42)" strokeWidth="1.4" strokeLinecap="round" />
          </g>
          <circle cx="80" cy="90" r="10" fill="#1f2937" />
          <circle cx="80" cy="90" r="4" fill="rgba(255,255,255,0.72)" />
        </svg>
      </div>
      <div className="min-w-0">
        <div className="text-4xl font-semibold leading-none tracking-tight text-ink-950 tabular-nums">{clamped}%</div>
        <div className="mt-2 text-base font-semibold text-ink-700">Trusted Coverage</div>
      </div>
    </div>
  );
}

function MemoryTrustBadge({ state }) {
  const key = MEMORY_TRUST_META[state] ? state : 'unknown';
  const meta = MEMORY_TRUST_META[key];
  return (
    <span
      title={meta.detail}
      className={`inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-xs font-semibold ${meta.badgeClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function normalizeClusterText(value) {
  return firstText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function memoryClusterKey(memory) {
  const route = getMemoryRoute(memory);
  const expression = normalizeClusterText(getMemoryLocatorExpression(memory));
  const element = normalizeClusterText(memory.elementKey || getMemoryTitle(memory));
  return [route.key, expression || element].join('|');
}

function trustRank(state) {
  return { trusted: 4, candidate: 3, degraded: 2, quarantined: 1, unknown: 0 }[state] || 0;
}

function sourceKey(memory) {
  const source = memory.source || {};
  return firstText(
    source.testCase?.id,
    memory.testCaseId,
    source.runResult?.id,
    memory.lastRunResultId,
    source.run?.id,
    memory.lastRunId,
  );
}

function buildMemoryCluster(memories) {
  const ordered = [...memories].sort((a, b) => {
    const trustDelta = trustRank(getMemoryTrust(b)) - trustRank(getMemoryTrust(a));
    if (trustDelta) return trustDelta;
    const healthDelta = (Number(b.healthScore) || 0) - (Number(a.healthScore) || 0);
    if (healthDelta) return healthDelta;
    return (b.successCount || 0) - (a.successCount || 0);
  });
  const best = ordered[0] || {};
  const states = ordered.map(getMemoryTrust);
  const state = states.includes('trusted')
    ? 'trusted'
    : states.includes('candidate')
      ? 'candidate'
      : states.includes('degraded')
        ? 'degraded'
        : states.includes('quarantined')
          ? 'quarantined'
          : 'unknown';
  const sourceLines = [...new Set(ordered.map(getMemorySourceLine).filter(Boolean))].slice(0, 4);
  const actionCounts = ordered.reduce((acc, memory) => {
    const action = normalizeActionType(memory.actionType || memory.toolName);
    acc[action] = (acc[action] || 0) + 1;
    return acc;
  }, {});
  const actionSummary = Object.entries(actionCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
  const titleSet = [...new Set(ordered.map(getMemoryTitle).filter(Boolean))].slice(0, 4);
  const fingerprints = ordered.map(getMemoryFingerprint).filter(Boolean);
  return {
    id: memoryClusterKey(best),
    best,
    memories: ordered,
    state,
    route: getMemoryRoute(best),
    title: getMemoryTitle(best),
    actionType: normalizeActionType(best.actionType || best.toolName),
    actionSummary,
    titles: titleSet,
    fingerprints,
    primaryFingerprint: getMemoryFingerprint(best) || fingerprints[0] || null,
    locatorExpression: getMemoryLocatorExpression(best),
    facts: getMemoryFacts(best),
    successCount: ordered.reduce((sum, memory) => sum + (memory.successCount || 0), 0),
    failureCount: ordered.reduce((sum, memory) => sum + (memory.failureCount || 0), 0),
    linkedCount: ordered.filter((memory) => sourceKey(memory)).length,
    sourceLines,
    health: Number.isFinite(Number(best.healthScore)) ? Number(best.healthScore) : null,
    lastSeen: ordered
      .map((memory) => memory.lastUsedAt || memory.updatedAt || memory.createdAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0],
  };
}

function MemoryFingerprintEvidence({ fingerprint, count }) {
  const semantic = fingerprint?.semantic || {};
  const structural = fingerprint?.structural || {};
  const attrs = fingerprint?.stableAttributes || {};
  const anchors = [
    ['Role', semantic.role],
    ['Name', semantic.accessibleName || semantic.placeholder || semantic.label],
    ['Test ID', semantic.testId],
    ['Type', semantic.type],
    ['Frame', structural.frameSelector],
    ['Shadow host', structural.shadowHostSelector],
    ['Container', structural.containerSelector || structural.formSelector || structural.rowSelector],
  ].filter(([, value]) => firstText(value)).slice(0, 7);
  const attrEntries = Object.entries(attrs).slice(0, 4);

  return (
    <div className="border-b border-white/60 bg-info-50/55 px-3 py-3">
      <div className="grid gap-3 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)] md:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-info-100 bg-white/80 px-2.5 text-xs font-semibold text-info-800">
              <Fingerprint className="h-3.5 w-3.5" aria-hidden="true" />
              {fingerprintLabel(fingerprint)}
            </span>
            <span className="text-xs font-medium text-info-700">
              {count} learned observation{count === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-xs text-info-700">
            {fingerprintIdentityLine(fingerprint)}
          </p>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {anchors.map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-lg border border-white/70 bg-white/70 px-2.5 py-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">{label}</div>
              <div className="mt-0.5 truncate text-xs font-semibold text-ink-800" title={String(value)}>{value}</div>
            </div>
          ))}
          {attrEntries.map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-lg border border-white/70 bg-white/70 px-2.5 py-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">{label}</div>
              <div className="mt-0.5 truncate text-xs font-semibold text-ink-800" title={String(value)}>{value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MemoryClusterCard({ cluster, expanded, onToggle, onCopy }) {
  const trustMeta = MEMORY_TRUST_META[cluster.state] || MEMORY_TRUST_META.unknown;
  const ActionIcon = ACTION_ICON_BY_TYPE[String(cluster.best.actionType || '').toLowerCase()] || Activity;
  const health = cluster.health;
  const healthWidth = `${Math.max(0, Math.min(100, health ?? 0))}%`;
  const healthTone = cluster.state === 'quarantined' ? 'bg-danger-500' : cluster.state === 'degraded' ? 'bg-warn-500' : 'bg-success-500';
  const sourceSummary = cluster.sourceLines.length
    ? cluster.sourceLines.join(' | ')
    : `${cluster.memories.length} legacy observation${cluster.memories.length === 1 ? '' : 's'}`;
  const primaryFacts = cluster.facts.slice(0, 3);
  const moreFacts = Math.max(0, cluster.facts.length - primaryFacts.length);

  return (
    <div className="group/locator relative border-t border-white/70 bg-white/58 px-4 py-3 transition-all duration-200 first:border-t-0 hover:z-10 hover:bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(240,253,250,0.72)_52%,rgba(239,246,255,0.78))] hover:shadow-[0_18px_38px_-30px_rgba(15,23,42,0.52),0_1px_0_rgba(255,255,255,0.9)_inset] motion-safe:hover:-translate-y-0.5">
      <div className="grid gap-3 xl:grid-cols-[minmax(170px,1.25fr)_108px_96px_78px_minmax(180px,0.95fr)_140px] xl:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white shadow-sm transition-transform duration-200 group-hover/locator:scale-[1.04]">
              <ActionIcon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold text-ink-950" title={cluster.titles.join(', ') || cluster.title}>
                {cluster.title}
              </h3>
              <span className={`h-1.5 w-1.5 rounded-full ${trustMeta.dotClass}`} aria-hidden="true" />
              <span className="text-xs font-semibold text-ink-600">{trustMeta.label}</span>
              {cluster.primaryFingerprint && (
                <span
                  className="inline-flex h-5 items-center gap-1 rounded-full border border-info-100 bg-info-50 px-2 text-[10px] font-semibold text-info-700"
                  title={cluster.primaryFingerprint.hash || ''}
                >
                  <Fingerprint className="h-3 w-3" aria-hidden="true" />
                  {fingerprintLabel(cluster.primaryFingerprint)}
                </span>
              )}
            </div>
            <div className="mt-1 truncate text-xs text-ink-500" title={primaryFacts.map((fact) => `${fact.label}: ${fact.value}`).join(' | ')}>
              {primaryFacts.length ? primaryFacts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ') : 'No DOM facts recorded'}
              {moreFacts > 0 ? ` · +${moreFacts} more` : ''}
            </div>
          </div>
        </div>

        <div className="text-sm text-ink-800">
          <div className="font-semibold tabular-nums">{cluster.memories.length} repeats</div>
          <div className="mt-0.5 text-xs text-ink-500">{formatMemoryDate(cluster.lastSeen)}</div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-ink-900">
            <span>{health == null ? 'n/a' : `${health}%`}</span>
          </div>
          <div
            className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100"
            role="progressbar"
            aria-label={`${cluster.title} health`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={health == null ? undefined : Math.max(0, Math.min(100, health))}
          >
            <div className={`h-full rounded-full transition-[width,filter] duration-300 group-hover/locator:brightness-110 ${healthTone}`} style={{ width: health == null ? '0%' : healthWidth }} />
          </div>
        </div>

        <div className="flex gap-1.5">
          {cluster.actionSummary.slice(0, 2).map((action) => (
            <span key={action.label} className="rounded-lg bg-white/70 px-2 py-1 text-center text-xs font-medium capitalize text-ink-700 shadow-sm ring-1 ring-white/70 transition-colors group-hover/locator:bg-white">
              <span className="block">{action.label}</span>
              <span className="block font-semibold tabular-nums">{action.count}</span>
            </span>
          ))}
        </div>

        <div
          className="qaai-scrollbar-none min-w-0 overflow-x-auto overflow-y-hidden rounded-2xl bg-ink-900 px-3 py-2.5 shadow-[0_12px_24px_-18px_rgba(15,23,42,0.8)] ring-1 ring-ink-700/90 transition-all duration-200 group-hover/locator:ring-info-200/40 group-hover/locator:shadow-[0_18px_30px_-18px_rgba(15,23,42,0.7)]"
          title={cluster.locatorExpression || ''}
          aria-label={`Locator expression for ${cluster.title}`}
        >
          <code className="block w-max whitespace-nowrap font-mono text-xs text-info-100">
            {cluster.locatorExpression || 'No exportable locator expression recorded'}
          </code>
        </div>

        <div className="flex flex-wrap items-center justify-start gap-1.5 xl:flex-nowrap xl:justify-end">
          <button
            type="button"
            onClick={() => onCopy(cluster.locatorExpression)}
            disabled={!cluster.locatorExpression}
            className="inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-ink-200 bg-white px-2 text-xs font-semibold text-ink-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-ink-50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
            aria-label={`Copy locator for ${cluster.title}`}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden 2xl:inline">Copy</span>
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="inline-flex h-9 items-center justify-center gap-1 rounded-lg bg-ink-900 px-2 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-ink-800 hover:shadow-md"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
            {expanded ? 'Hide' : 'Evidence'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.76),rgba(240,253,250,0.54),rgba(239,246,255,0.58))] shadow-[0_16px_36px_-28px_rgba(15,23,42,0.45)] backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/65 bg-white/45 px-3 py-2 text-xs text-ink-500">
            <span className="font-semibold uppercase tracking-wide">Where this locator repeats</span>
            <span><span className="font-semibold text-ink-800">{trustMeta.label}</span> - {trustMeta.detail}</span>
          </div>
          {cluster.primaryFingerprint && (
            <MemoryFingerprintEvidence fingerprint={cluster.primaryFingerprint} count={cluster.fingerprints.length} />
          )}
          <div className="divide-y divide-white/60">
            {cluster.memories.slice(0, 8).map((memory) => {
              const source = memory.source || {};
              const sourceLine = getMemorySourceLine(memory);
              return (
                <div key={memory.id} className="grid gap-2 px-3 py-3 text-xs text-ink-600 md:grid-cols-[minmax(0,1fr)_120px_120px_160px] md:items-center">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink-900" title={sourceLine || ''}>
                      {sourceLine || 'Legacy capture'}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-ink-400" title={memory.stepIntentHash || ''}>
                      {memory.stepIntentHash || 'no step hash'}
                    </div>
                  </div>
                  <MemoryTrustBadge state={getMemoryTrust(memory)} />
                  <div>{Number.isFinite(Number(memory.healthScore)) ? `${memory.healthScore}% health` : 'health n/a'}</div>
                  <div className="text-ink-500">{formatMemoryDate(memory.lastUsedAt || memory.updatedAt || memory.createdAt)}</div>
                  {source.runResult?.status && <div className="md:col-span-4 text-ink-500">Run result: {source.runResult.status}</div>}
                </div>
              );
            })}
            {cluster.memories.length > 8 && (
              <div className="px-3 py-2 text-xs font-medium text-ink-500">
                {cluster.memories.length - 8} older observations hidden.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkspaceMemory() {
  const { projectId } = useParams();
  const { summary } = useOutletContext() || {};
  const toast = useToast();
  const [memories, setMemories] = useState([]);
  const [memorySummary, setMemorySummary] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedMemory, setExpandedMemory] = useState(null);
  const [collapsedRoutes, setCollapsedRoutes] = useState(() => new Set());

  const loadMemory = useCallback(async ({ silent = false, isCancelled = () => false } = {}) => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get(`/projects/${projectId}/action-memory`);
      if (!isCancelled()) {
        setMemories(response.memories || []);
        setMemorySummary(response.summary || null);
        if (silent) toast.success('Memory refreshed.');
      }
    } catch (err) {
      if (!isCancelled()) {
        setMemories([]);
        setMemorySummary(null);
        const message = err?.message || 'Memory could not load. Check the project connection and try again.';
        setError(message);
        if (silent) toast.error(message);
      }
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    let cancelled = false;
    loadMemory({ isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [loadMemory]);

  const stats = useMemo(() => {
    const clusterMap = new Map();
    memories.forEach((memory) => {
      const key = memoryClusterKey(memory);
      if (!clusterMap.has(key)) clusterMap.set(key, []);
      clusterMap.get(key).push(memory);
    });
    const clusters = [...clusterMap.values()].map(buildMemoryCluster);
    const counts = clusters.reduce((acc, cluster) => {
      const state = cluster.state;
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {});
    return {
      total: memories.length,
      clusterCount: clusters.length,
      trusted: counts.trusted || 0,
      candidate: counts.candidate || 0,
      degraded: counts.degraded || 0,
      quarantined: counts.quarantined || 0,
      routeCount: memorySummary?.routeCount || new Set(memories.map((memory) => getMemoryRoute(memory).key)).size,
    };
  }, [memories, memorySummary]);

  const clusters = useMemo(() => {
    const map = new Map();
    memories.forEach((memory) => {
      const key = memoryClusterKey(memory);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(memory);
    });
    return [...map.values()]
      .map(buildMemoryCluster)
      .sort((a, b) => {
        const routeCompare = a.route.label.localeCompare(b.route.label);
        if (routeCompare !== 0) return routeCompare;
        return trustRank(b.state) - trustRank(a.state) || b.memories.length - a.memories.length;
      });
  }, [memories]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return clusters
      .filter((cluster) => filter === 'all' || cluster.state === filter)
      .filter((cluster) => {
        if (!needle) return true;
        const clusterText = [
          cluster.title,
          cluster.actionType,
          cluster.route.label,
          cluster.route.url,
          cluster.locatorExpression,
          ...cluster.sourceLines,
          ...cluster.facts.flatMap((fact) => [fact.label, fact.value]),
          ...cluster.memories.map(buildMemorySearchText),
        ].filter(Boolean).join(' ').toLowerCase();
        return clusterText.includes(needle);
      });
  }, [clusters, query, filter]);

  const groups = useMemo(() => {
    const map = new Map();
    filtered.forEach((cluster) => {
      const route = cluster.route;
      if (!map.has(route.key)) map.set(route.key, { ...route, clusters: [], observationCount: 0 });
      map.get(route.key).clusters.push(cluster);
      map.get(route.key).observationCount += cluster.memories.length;
    });
    return [...map.values()].sort((a, b) => b.observationCount - a.observationCount || a.label.localeCompare(b.label));
  }, [filtered]);

  const memoryHealth = useMemo(() => {
    if (!stats.clusterCount) return 0;
    return Math.round((stats.trusted / stats.clusterCount) * 100);
  }, [stats.clusterCount, stats.trusted]);

  const filterOptions = [
    { id: 'all', label: 'All', count: stats.clusterCount },
    { id: 'trusted', label: 'Trusted', count: stats.trusted },
    { id: 'candidate', label: 'Observed', count: stats.candidate },
    { id: 'degraded', label: 'Drifted', count: stats.degraded },
    { id: 'quarantined', label: 'Quarantined', count: stats.quarantined },
  ];

  const toggleRoute = (routeKey) => {
    setCollapsedRoutes((current) => {
      const next = new Set(current);
      if (next.has(routeKey)) next.delete(routeKey);
      else next.add(routeKey);
      return next;
    });
  };

  const copyLocator = async (locatorExpression) => {
    if (!locatorExpression || !navigator?.clipboard) {
      toast.error('Clipboard is unavailable in this browser.');
      return;
    }
    try {
      await navigator.clipboard.writeText(locatorExpression);
      toast.success('Locator copied.');
    } catch {
      toast.error('Could not copy the locator. Select the locator text and copy it manually.');
    }
  };

  const clearSearch = () => {
    setQuery('');
    setFilter('all');
  };

  const collapseAllRoutes = () => {
    setCollapsedRoutes(new Set(groups.map((group) => group.key)));
    setExpandedMemory(null);
  };

  const expandAllRoutes = () => {
    setCollapsedRoutes(new Set());
  };

  const visibleRouteKeys = new Set(groups.map((group) => group.key));
  const visibleCollapsedCount = [...collapsedRoutes].filter((key) => visibleRouteKeys.has(key)).length;
  const allVisibleRoutesCollapsed = groups.length > 0 && visibleCollapsedCount === groups.length;
  const projectName = summary?.project?.name || 'This project';

  return (
    <div className="relative h-full overflow-auto">
      <div className="sticky top-0 z-0 h-[100dvh] overflow-hidden" style={{ marginBottom: '-100dvh' }} aria-hidden="true">
        <MemoryAuroraBackground />
      </div>
      <div className="relative z-10 mx-auto flex max-w-[1680px] flex-col gap-5 px-page py-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Memory Management</h1>
            <p className="mt-1 text-sm text-ink-700">Project: {projectName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => loadMemory({ silent: true })}
                disabled={loading}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
                Refresh
              </button>
              {query || filter !== 'all' ? (
                <button
                  type="button"
                  onClick={clearSearch}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/70 bg-white/65 px-3 text-sm font-semibold text-ink-700 shadow-sm backdrop-blur transition-colors hover:bg-white/85"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                  Clear View
                </button>
              ) : null}
            </div>
          </div>

        <section className="glass overflow-hidden">
          <div className="grid gap-6 p-5 xl:grid-cols-[minmax(260px,360px)_minmax(0,1fr)] xl:items-center">
            <MemoryCoverageGauge value={memoryHealth} />

            <div className="relative min-w-0 overflow-hidden rounded-[26px] border border-white/70 bg-[linear-gradient(135deg,rgba(236,253,245,0.78)_0%,rgba(255,255,255,0.74)_42%,rgba(239,246,255,0.72)_72%,rgba(245,243,255,0.76)_100%)] p-3 shadow-[0_22px_55px_-28px_rgba(15,23,42,0.42),0_1px_0_rgba(255,255,255,0.9)_inset] backdrop-blur-xl">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_12%,rgba(16,185,129,0.24),transparent_28%),radial-gradient(circle_at_88%_18%,rgba(99,102,241,0.20),transparent_34%),radial-gradient(circle_at_50%_105%,rgba(14,165,233,0.13),transparent_42%)]" aria-hidden="true" />
              <div className="relative min-w-0 space-y-3">
                <div className="flex min-w-0 flex-wrap items-start gap-2.5">
                  <dl className="grid min-w-[280px] flex-[0_1_430px] grid-cols-2 gap-2">
                    <div className="flex h-11 min-w-0 items-center justify-between gap-3 rounded-2xl border border-white/75 bg-white/72 px-3.5 shadow-[0_10px_24px_-18px_rgba(15,23,42,0.36),0_1px_0_rgba(255,255,255,0.82)_inset] transition-all duration-200 hover:-translate-y-0.5 hover:border-white hover:bg-white/90 hover:shadow-[0_16px_30px_-20px_rgba(15,23,42,0.44),0_1px_0_rgba(255,255,255,0.95)_inset]">
                      <dt className="text-[11px] font-semibold uppercase text-ink-500">Observations</dt>
                      <dd className="text-base font-semibold text-ink-950 tabular-nums">{stats.total}</dd>
                    </div>
                    <div className="flex h-11 min-w-0 items-center justify-between gap-3 rounded-2xl border border-white/75 bg-white/72 px-3.5 shadow-[0_10px_24px_-18px_rgba(15,23,42,0.36),0_1px_0_rgba(255,255,255,0.82)_inset] transition-all duration-200 hover:-translate-y-0.5 hover:border-white hover:bg-white/90 hover:shadow-[0_16px_30px_-20px_rgba(15,23,42,0.44),0_1px_0_rgba(255,255,255,0.95)_inset]">
                      <dt className="text-[11px] font-semibold uppercase text-ink-500">Page scopes</dt>
                      <dd className="text-base font-semibold text-ink-950 tabular-nums">{stats.routeCount}</dd>
                    </div>
                  </dl>

                  <div className="min-w-[420px] flex-1 rounded-2xl border border-white/75 bg-white/62 p-1.5 shadow-[0_14px_30px_-22px_rgba(15,23,42,0.38),0_1px_0_rgba(255,255,255,0.8)_inset] max-[820px]:min-w-full" aria-label="Memory trust filters">
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                  {filterOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setFilter(option.id)}
                    aria-pressed={filter === option.id}
                    className={`group/filter inline-flex h-10 min-w-[118px] flex-1 items-center justify-between gap-2 rounded-xl px-3 text-sm font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_22px_-18px_rgba(15,23,42,0.5)] focus-visible:shadow-ring sm:flex-none ${
                      filter === option.id
                        ? 'bg-ink-900 text-white shadow-sm'
                        : 'text-ink-600 hover:bg-white/88 hover:text-ink-900'
                    }`}
                  >
                    <span>{option.label}</span>
                    <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums transition-colors ${filter === option.id ? 'bg-white/15 text-white group-hover/filter:bg-white/25' : 'bg-white/70 text-ink-500 group-hover/filter:bg-ink-900 group-hover/filter:text-white'}`}>
                      {option.count}
                    </span>
                  </button>
                  ))}
                    </div>
                  </div>
                </div>

                <label className="relative block min-w-0 max-w-[560px]">
                  <span className="sr-only">Search project memory</span>
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
                  <input
                    name="memory-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search memory"
                    autoComplete="off"
                    className="h-12 w-full rounded-2xl border border-ink-200/70 bg-white/90 pl-10 pr-10 text-sm text-ink-800 shadow-[0_14px_30px_-22px_rgba(15,23,42,0.45),0_1px_0_rgba(255,255,255,0.95)_inset] outline-none backdrop-blur transition-all duration-200 placeholder:text-ink-400 hover:-translate-y-0.5 hover:border-white hover:bg-white hover:shadow-[0_20px_34px_-24px_rgba(15,23,42,0.5),0_1px_0_rgba(255,255,255,1)_inset] focus:border-info-300 focus:bg-white focus-visible:shadow-ring"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-xl text-ink-400 transition-colors hover:bg-white/80 hover:text-ink-700"
                      aria-label="Clear memory search"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </label>
              </div>
            </div>
          </div>
        </section>

        <section className="glass overflow-visible">
          <div className="flex flex-col gap-3 border-b border-white/55 bg-white/25 px-5 py-4 backdrop-blur-sm lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink-950">Reusable locator inventory</h2>
              <p className="mt-1 text-sm text-ink-500">
                {filtered.length} of {stats.clusterCount} unique locators match the current view, backed by {stats.total} observations.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={allVisibleRoutesCollapsed ? expandAllRoutes : collapseAllRoutes}
                disabled={groups.length === 0}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/70 bg-white/65 px-3 text-xs font-semibold text-ink-700 shadow-sm transition-colors hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {allVisibleRoutesCollapsed ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                {allVisibleRoutesCollapsed ? 'Expand Routes' : 'Collapse Routes'}
              </button>
              <div className="inline-flex items-center gap-2 rounded-xl border border-success-200/70 bg-success-50/70 px-3 py-2 text-xs font-medium text-success-800 shadow-sm">
                <CheckCircle2 className="h-4 w-4 text-success-600" aria-hidden="true" />
                Repeated locator evidence is collapsed into one row.
              </div>
            </div>
          </div>
        {loading ? (
          <div className="divide-y divide-white/55 bg-white/20 backdrop-blur-sm" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div key={item} className="p-4">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-8 w-8 shrink-0" rounded="lg" />
                  <div className="min-w-0 flex-1 space-y-3">
                    <Skeleton className="h-4 w-2/5" rounded="pill" />
                    <Skeleton className="h-3 w-4/5" rounded="pill" />
                    <Skeleton className="h-9 w-full" rounded="lg" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-5">
            <div className="rounded-xl border border-danger-200/70 bg-danger-50/80 p-5 shadow-sm backdrop-blur">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-danger-600" aria-hidden="true" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-danger-900">Memory Could Not Load</h3>
                    <p className="mt-1 break-words text-sm text-danger-700">{error}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => loadMemory({ silent: true })}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl bg-danger-700 px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-danger-800"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Try Again
                </button>
              </div>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-5">
            <div className="glass-soft p-10 text-center">
              <Brain className="mx-auto h-8 w-8 text-ink-400" aria-hidden="true" />
              <h3 className="mt-4 text-base font-semibold text-ink-950">No matching memory</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-ink-500">
                Adjust the search or filter to inspect captured locators, source tests, and action evidence.
              </p>
            </div>
            {(query || filter !== 'all') && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={clearSearch}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-ink-800"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                  Clear Filters
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-3">
            {groups.map((group) => {
              const collapsed = collapsedRoutes.has(group.key);
              const trustedCount = group.clusters.filter((cluster) => cluster.state === 'trusted').length;
              return (
                <div key={group.key} className="mb-4 overflow-hidden rounded-[26px] border border-white/70 bg-[linear-gradient(135deg,rgba(236,253,245,0.62),rgba(255,255,255,0.74)_38%,rgba(239,246,255,0.66)_72%,rgba(245,243,255,0.62))] shadow-[0_18px_48px_-34px_rgba(15,23,42,0.46),0_1px_0_rgba(255,255,255,0.86)_inset] backdrop-blur-xl last:mb-0">
                  <button
                    type="button"
                    onClick={() => toggleRoute(group.key)}
                    aria-expanded={!collapsed}
                    className="group/route flex w-full flex-col gap-2 px-5 py-4 text-left transition-all duration-200 hover:bg-white/42 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/78 text-ink-600 shadow-[0_10px_22px_-18px_rgba(15,23,42,0.42)] ring-1 ring-white/75 transition-transform duration-200 group-hover/route:scale-105">
                        {collapsed ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-ink-950" title={group.url || group.key}>{group.label}</span>
                        <span className="mt-1 block text-xs text-ink-500">{group.clusters.length} locators - {group.observationCount} observations - {trustedCount} trusted</span>
                      </span>
                    </span>
                    <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/75 bg-white/72 px-2.5 py-1 text-xs font-semibold text-ink-600 shadow-[0_10px_22px_-18px_rgba(15,23,42,0.42)]">
                      <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {shortMemoryUrl(group.url) || 'route scope'}
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="px-4 pb-4">
                      <div className="hidden grid-cols-[minmax(170px,1.25fr)_108px_96px_78px_minmax(180px,0.95fr)_140px] gap-3 rounded-t-2xl border border-white/75 bg-white/64 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500 shadow-[0_1px_0_rgba(255,255,255,0.85)_inset] xl:grid">
                        <span>Element</span>
                        <span>Frequency</span>
                        <span>Health</span>
                        <span>Actions</span>
                        <span>Locator</span>
                        <span className="text-right">Controls</span>
                      </div>
                      <div className="overflow-hidden rounded-2xl border border-white/75 bg-white/58 shadow-[0_18px_40px_-32px_rgba(15,23,42,0.46),0_1px_0_rgba(255,255,255,0.88)_inset] xl:rounded-t-none xl:border-t-0">
                      {group.clusters.map((cluster) => (
                        <MemoryClusterCard
                          key={cluster.id}
                          cluster={cluster}
                          expanded={expandedMemory === cluster.id}
                          onToggle={() => setExpandedMemory((current) => (current === cluster.id ? null : cluster.id))}
                          onCopy={copyLocator}
                        />
                      ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </section>
      </div>
    </div>
  );
}

export function WorkspaceFiles() {
  const { projectId } = useParams();
  const { summary } = useOutletContext() || {};
  const cards = [
    { label: 'Requirements', count: summary?.counts?.requirements || 0, icon: Database, to: '/project-setup' },
    { label: 'Test data sets', count: summary?.counts?.testDataSets || 0, icon: FileSpreadsheet, to: `/projects/${projectId}/tests` },
    { label: 'Output files', count: summary?.outputReadiness?.prepared || 0, icon: Folder, to: `/projects/${projectId}/output-files` },
  ];

  return (
    <WorkspacePage>
      <Panel title="Files" subtitle="Project source material, data files, and generated output references.">
        <div className="grid gap-4 md:grid-cols-3">
          {cards.map(({ label, count, icon: Icon, to }) => (
            <Link key={label} to={to} className="rounded-lg border border-ink-200 p-5 transition hover:border-ink-300 hover:shadow-sm">
              <Icon className="h-5 w-5 text-ink-500" aria-hidden="true" />
              <div className="mt-5 text-2xl font-semibold text-ink-950">{count}</div>
              <div className="mt-1 text-sm text-ink-500">{label}</div>
            </Link>
          ))}
        </div>
      </Panel>
    </WorkspacePage>
  );
}

export function WorkspaceIntegrations() {
  const { summary } = useOutletContext() || {};
  const project = summary?.project || {};
  const rows = [
    { icon: GitBranch, title: 'Source Control', body: project.repoUrl || 'Connect a Git repository for PR testing and code review workflows.', status: project.repoUrl ? 'Connected' : 'Set up' },
    { icon: Webhook, title: 'Deployment Providers', body: 'Run selected test groups from preview deployments and custom webhooks.', status: 'Set up' },
    { icon: Shield, title: 'Site Protection', body: 'HTTP Basic Auth, Cloudflare Access, and protected preview bypass settings.', status: 'Set up' },
    { icon: Mail, title: 'Notifications', body: 'Email, Slack, and webhook alerts for failed or scheduled runs.', status: 'Configure' },
  ];

  return (
    <WorkspacePage>
      <Panel title="Integrations" subtitle="Connect deployment, repository, site protection, and notification systems.">
        <div className="overflow-hidden rounded-lg border border-ink-200">
          {rows.map(({ icon: Icon, title, body, status }) => (
            <div key={title} className="flex flex-col gap-3 border-b border-ink-100 px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-ink-500" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="font-semibold text-ink-950">{title}</div>
                  <div className="mt-1 text-sm text-ink-500">{body}</div>
                </div>
              </div>
              <button type="button" className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-ink-200 bg-white px-3 text-sm font-medium text-ink-700">
                <Settings className="h-4 w-4" aria-hidden="true" />
                {status}
              </button>
            </div>
          ))}
        </div>
      </Panel>
    </WorkspacePage>
  );
}

export function WorkspaceOverviewRedirectNotice() {
  return (
    <WorkspacePage>
      <Panel title="Workspace" subtitle="Choose a project tab to continue.">
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          The project workspace is ready.
        </div>
      </Panel>
    </WorkspacePage>
  );
}
