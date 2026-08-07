import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  PlayCircle,
  SendHorizontal,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import Button from './ui/Button';
import api from '../lib/apiClient';

function compact(value, fallback = 'n/a') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function shortId(value) {
  const text = compact(value, '');
  return text ? text.slice(0, 8) : 'latest';
}

function tailPath(value, keep = 2) {
  const parts = String(value || '').split('/').filter(Boolean);
  return parts.length > keep ? parts.slice(-keep).join('/') : parts.join('/') || 'n/a';
}

function listPreview(items, max = 3) {
  const values = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!values.length) return 'none visible';
  const shown = values.slice(0, max).map((item) => tailPath(item.path || item));
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

function statusMeta(status) {
  const key = String(status || 'not_run');
  if (key === 'certified') return { label: 'Certified', cls: 'bg-success-50 text-success-700 border-success-200', icon: CheckCircle2 };
  if (key === 'healed') return { label: 'Healed', cls: 'bg-info-50 text-info-700 border-info-200', icon: CheckCircle2 };
  if (key === 'failed') return { label: 'Repair available', cls: 'bg-danger-50 text-danger-700 border-danger-200', icon: AlertTriangle };
  if (key === 'preview_only') return { label: 'Preview only', cls: 'bg-warn-50 text-warn-700 border-warn-200', icon: AlertTriangle };
  if (key === 'queued') return { label: 'Queued', cls: 'bg-info-50 text-info-700 border-info-200', icon: PlayCircle };
  if (key === 'running') return { label: 'Validating', cls: 'bg-info-50 text-info-700 border-info-200', icon: Sparkles };
  return { label: 'Not run', cls: 'bg-ink-50 text-ink-600 border-ink-200', icon: PlayCircle };
}

function fileKindSummary(files) {
  const all = Array.isArray(files) ? files : [];
  const counts = all.reduce((acc, file) => {
    const key = file.kind || 'misc';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ') || `${all.length} files`;
}

function explainFailure(failure) {
  if (!failure) {
    return [
      'No active failure',
      '- I do not have a script validation failure for this bundle yet.',
      '- Run scripts so I can inspect exact file/line evidence, traces, screenshots, and the repair journal.',
    ].join('\n');
  }
  const error = String(failure.error || '');
  const target = `${failure.file || 'unknown file'}:${failure.line || 1}`;
  if (/strict mode|strict locator|resolved to|locator/i.test(error)) {
    return [
      'Locator repair needed',
      `- Failed line: ${target}`,
      '- Meaning: Playwright reached the page, but the generated locator was not precise enough to safely choose one element.',
      '- Next: patch the generated file with a stronger role, label, test id, or scoped locator, then rerun only this failed test.',
    ].join('\n');
  }
  if (/timeout|waiting|exceeded/i.test(error)) {
    return [
      'Wait or state mismatch',
      `- Failed line: ${target}`,
      '- Meaning: the generated script waited for a condition that did not become true during validation.',
      '- Next: inspect trace/screenshot evidence, then repair the wait, assertion, or locator.',
    ].join('\n');
  }
  if (/expect|assert/i.test(error)) {
    return [
      'Assertion mismatch',
      `- Failed line: ${target}`,
      '- Meaning: the script executed, but the expected oracle did not match validation evidence.',
      '- Next: compare the assertion with scenario intent, mapped test data, and expected result.',
    ].join('\n');
  }
  return [
    'Script validation issue',
    `- Failed line: ${target}`,
    '- Meaning: this generated Playwright bundle did not pass QAAI script validation.',
    '- Next: open the line, inspect the captured error, patch the generated bundle, and rerun the failed test.',
  ].join('\n');
}

function summarizeActiveFile(activeFile) {
  if (!activeFile?.path) {
    return [
      'Selected file',
      '- No generated file is selected right now.',
    ].join('\n');
  }
  const text = String(activeFile.content || '');
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim()).length;
  const locatorHints = [
    ['getByRole', text.match(/getByRole\s*\(/g)?.length || 0],
    ['getByText', text.match(/getByText\s*\(/g)?.length || 0],
    ['locator', text.match(/\.locator\s*\(/g)?.length || 0],
    ['resolveLocator', text.match(/resolveLocator\s*\(/g)?.length || 0],
  ].filter(([, count]) => count > 0);
  const locatorSummary = locatorHints.length
    ? locatorHints.map(([name, count]) => `${name} ${count}`).join(', ')
    : 'none detected in this file';
  return [
    'Selected file',
    `- Path: ${activeFile.path}`,
    `- Size: ${lines.length} lines, ${nonEmpty} non-empty`,
    `- Locator signals: ${locatorSummary}`,
  ].join('\n');
}

function summarizeFileList(files) {
  const all = Array.isArray(files) ? files : [];
  if (!all.length) {
    return [
      'Bundle snapshot',
      '- Output file tree is not loaded in this assistant context yet.',
    ].join('\n');
  }
  const dataFiles = all.filter((file) => file.kind === 'data' || /data|fixture|env/i.test(file.path || ''));
  return [
    'Bundle snapshot',
    `- Files: ${all.length} (${fileKindSummary(all)})`,
    `- Data/fixture files: ${listPreview(dataFiles, 3)}`,
  ].join('\n');
}

function initialAssistantMessage({ report, primaryFailure, activeFile, fileList }) {
  if (primaryFailure) {
    return [
      'I found a generated-script validation failure.',
      '',
      explainFailure(primaryFailure),
      '',
      summarizeActiveFile(activeFile),
      '',
      'Available actions',
      '- View the failed line',
      '- Repair the generated output file',
      '- Rerun scripts',
      '- Open the repair journal',
    ].join('\n');
  }
  const status = String(report?.status || 'not_run');
  if (status === 'certified') {
    return [
      'This bundle has clean script validation evidence.',
      '',
      summarizeActiveFile(activeFile),
      '',
      'Available actions',
      '- Explain certification evidence',
      '- Scan the selected file',
      '- Rerun scripts for fresh proof',
    ].join('\n');
  }
  if (status === 'healed') {
    return [
      'This bundle was repaired and rerun successfully.',
      '',
      summarizeActiveFile(activeFile),
      '',
      'Audit trail',
      '- The repair journal records what changed before certification.',
    ].join('\n');
  }
  return [
    'I am watching the generated Output Files bundle.',
    '',
    summarizeFileList(fileList),
    '',
    summarizeActiveFile(activeFile),
    '',
    'Next best step',
    '- Run scripts to validate the Playwright output and collect exact repair evidence.',
  ].join('\n');
}

function makeAssistantReply(text, ctx) {
  const lower = String(text || '').toLowerCase();
  const specFiles = (ctx.fileList || []).filter((file) => (
    file?.kind === 'spec'
    || /\.spec\.(t|j)sx?$/i.test(file?.path || '')
  ));
  const dataFiles = (ctx.fileList || []).filter((file) => (
    file?.kind === 'data'
    || /(^|\/)(data|fixtures?|seeds?)(\/|$)/i.test(file?.path || '')
    || /\.(json|csv|xlsx?)$/i.test(file?.path || '')
  ));

  if (/^\/?run scripts$/i.test(String(text || '').trim())) {
    return [
      'Script validation',
      '- I will trigger QAAI script validation for this generated bundle.',
      '- This runs in the Output Files script runner, separate from the live Conductor loop.',
    ].join('\n');
  }
  if (/generated test|test case|spec file|current run|read.*test|show.*test/.test(lower)) {
    return [
      'Current bundle test files',
      specFiles.length
        ? `- I can see ${specFiles.length} generated spec file${specFiles.length === 1 ? '' : 's'} in this selected bundle: ${listPreview(specFiles, 6)}.`
        : '- I do not see a generated .spec file in the selected bundle list yet.',
      ctx.activeFile?.path ? `- Selected file right now: ${ctx.activeFile.path}.` : '- No file is selected right now.',
      '- Ask for a specific file path or select a file in Output Files and I will answer from that current bundle only.',
    ].join('\n');
  }
  if (/^\/?(preview repair|repair active line|repair failed line)$/i.test(String(text || '').trim())) {
    if (ctx.primaryFailure?.repairAvailable) {
      return [
        'Repair target',
        `- File: ${ctx.primaryFailure.file || 'unknown file'}`,
        `- Line: ${ctx.primaryFailure.line || 1}`,
        '- Scope: generated output bundle only',
        '- After patch: QAAI reruns the failed test scope and updates the repair journal.',
      ].join('\n');
    }
    return [
      'No repairable failure yet',
      '- Run scripts first, or select a failed validation row.',
    ].join('\n');
  }
  if (/line|open|where/.test(lower)) {
    if (ctx.primaryFailure?.file) {
      return [
        'Failed line',
        `- ${ctx.primaryFailure.file}:${ctx.primaryFailure.line || 1}`,
        '- I can open and highlight it in the Output Files editor.',
      ].join('\n');
    }
    return summarizeActiveFile(ctx.activeFile);
  }
  if (/scenario|step|miss|coverage|data|row|fixture|oracle/.test(lower)) {
    return [
      'Scenario and data coverage',
      '- I compare generated scripts against available scenario, test-step, data-row, and oracle artifacts.',
      `- Generated specs: ${listPreview(specFiles, 8)}.`,
      `- Data/fixture files: ${listPreview(dataFiles, 8)}.`,
      ctx.primaryFailure
        ? `- Current failure should be checked against the scenario step that produced ${ctx.primaryFailure.file || 'the failed file'}:${ctx.primaryFailure.line || 1}.`
        : '- No failed line is active yet.',
    ].join('\n');
  }
  if (/journal|history|what changed/.test(lower)) {
    if (ctx.repairs.length) {
      return [
        'Repair journal',
        `- Entries: ${ctx.repairs.length}`,
        '- Includes before/after hashes, reason, rerun status, and timestamps.',
      ].join('\n');
    }
    return [
      'Repair journal',
      '- No repair journal exists for this bundle yet.',
      '- It appears after a generated-script patch is applied and rerun.',
    ].join('\n');
  }
  if (/file|scan|read|content/.test(lower)) {
    return [summarizeActiveFile(ctx.activeFile), '', summarizeFileList(ctx.fileList)].join('\n');
  }
  if (ctx.primaryFailure) return explainFailure(ctx.primaryFailure);
  return [
    'I am scoped to this generated output bundle.',
    '',
    'What I can answer from here',
    '- Inspect the selected output file.',
    '- Read generated spec/test-case files in this bundle.',
    '- Compare scripts against visible data, fixture, scenario, and oracle artifacts.',
    '- Explain script validation and repair evidence.',
    '- Use exact commands only for actions: /run scripts, /preview repair, /apply patch.',
  ].join('\n');
}

function cleanAssistantPath(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\\/g, '/');
}

function parseLinePatchCommand(text, activeFilePath) {
  const raw = String(text || '').trim();
  const explicit = raw.match(/^(?:change|replace|set)\s+line\s+(\d+)\s+(?:in|of)\s+(.+?)\s+(?:to|with)\s+([\s\S]+)$/i);
  if (explicit) {
    return {
      line: Number(explicit[1]),
      file: cleanAssistantPath(explicit[2]),
      replacementLine: explicit[3].replace(/^["'`]+|["'`]+$/g, ''),
    };
  }
  const selected = raw.match(/^(?:change|replace|set)\s+line\s+(\d+)\s+(?:to|with)\s+([\s\S]+)$/i);
  if (selected && activeFilePath) {
    return {
      line: Number(selected[1]),
      file: cleanAssistantPath(activeFilePath),
      replacementLine: selected[2].replace(/^["'`]+|["'`]+$/g, ''),
    };
  }
  return null;
}

function stripCodeFence(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : text.replace(/^["'`]+|["'`]+$/g, '');
}

function parseFullFileRewriteCommand(text, activeFilePath) {
  const raw = String(text || '').trim();
  const fence = raw.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```/);
  const explicit = raw.match(/^(?:rewrite|replace|regenerate)\s+(?:file\s+)?(.+?)\s+(?:with|as)\s+```[a-zA-Z0-9_-]*\s*\n[\s\S]*?\n?```/i);
  if (explicit && fence) {
    return {
      file: cleanAssistantPath(explicit[1]),
      replacement: fence[1],
      instruction: raw.slice(0, Math.max(0, raw.indexOf('```'))).trim(),
    };
  }
  const selectedWithFence = raw.match(/^(?:rewrite|replace|regenerate)\s+(?:this|current|selected)?\s*(?:file|script)?\s*(?:with|as)\s+```[a-zA-Z0-9_-]*\s*\n[\s\S]*?\n?```/i);
  if (selectedWithFence && fence && activeFilePath) {
    return {
      file: cleanAssistantPath(activeFilePath),
      replacement: fence[1],
      instruction: raw.slice(0, Math.max(0, raw.indexOf('```'))).trim(),
    };
  }
  const inlineExplicit = raw.match(/^(?:rewrite|replace|regenerate)\s+(?:file\s+)?(.+?)\s+(?:with|as)\s+([\s\S]+)$/i);
  if (inlineExplicit && /[;\n{}]|import\s|export\s|await\s|test\s*\(/i.test(inlineExplicit[2])) {
    return {
      file: cleanAssistantPath(inlineExplicit[1]),
      replacement: stripCodeFence(inlineExplicit[2]),
      instruction: raw.slice(0, Math.max(0, raw.toLowerCase().indexOf(' with '))).trim(),
    };
  }
  if (/^(?:rewrite|fix|repair|regenerate)\b/i.test(raw) && /\b(file|script|spec|page object|helper)\b/i.test(raw) && activeFilePath) {
    return {
      file: cleanAssistantPath(activeFilePath),
      replacement: null,
      instruction: raw,
    };
  }
  return null;
}

function parseCreateFileCommand(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const intent = (
    /\b(create|write|generate|build|make)\b.*\b(complete\s+)?(script|spec|test file|playwright|automation)\b/.test(lower)
    || /\b(can you|please)\s+(write|create|generate)\b.*\b(script|spec|test)\b/.test(lower)
  );
  if (!intent) return null;
  const fence = raw.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```/);
  const fileMatch = raw.match(/\b(?:file|path|as|into)\s+([A-Za-z0-9_.\-\/\\]+?\.(?:spec\.)?(?:ts|js|feature))\b/i);
  return {
    file: fileMatch ? cleanAssistantPath(fileMatch[1]) : null,
    content: fence ? fence[1] : null,
    instruction: raw,
  };
}

function FormattedMessage({ content }) {
  const sections = String(content || '').split(/\n{2,}/).filter((section) => section.trim());
  return (
    <div className="space-y-3">
      {sections.map((section, index) => {
        const lines = section.split('\n').map((line) => line.trim()).filter(Boolean);
        const title = lines[0] && !lines[0].startsWith('-') ? lines[0] : null;
        const bullets = lines.filter((line) => line.startsWith('-')).map((line) => line.replace(/^-\s*/, ''));
        const plain = lines.filter((line) => !line.startsWith('-') && line !== title);
        return (
          <div key={`${index}-${section.slice(0, 12)}`} className="space-y-1.5">
            {title && <p className="text-[13px] font-semibold text-inherit">{title}</p>}
            {plain.map((line) => (
              <p key={line} className="text-[13px] leading-6">{line}</p>
            ))}
            {bullets.length > 0 && (
              <ul className="space-y-1 text-[13px] leading-6">
                {bullets.map((line) => (
                  <li key={line} className="flex gap-2">
                    <span className="mt-[0.68rem] h-1 w-1 shrink-0 rounded-full bg-current opacity-45" />
                    <span className="min-w-0 break-words">{line}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChatBubble({ message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-2xl px-4 py-3 shadow-sm ${
          isUser
            ? 'bg-ink-900 text-white'
            : 'border border-ink-100 bg-white text-ink-800'
        }`}
      >
        <FormattedMessage content={message.content} />
      </div>
    </div>
  );
}

function RepairProposalCard({ proposal, applying, onApply, onDiscard }) {
  if (!proposal) return null;
  const target = proposal.diff?.target || {};
  const changed = Array.isArray(proposal.diff?.changed) ? proposal.diff.changed : [];
  return (
    <div className="border-b border-info-100 bg-info-50/75 px-5 py-3">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-info-900">Repair preview</span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-info-700 ring-1 ring-info-100">
                {tailPath(proposal.file, 3)}:{proposal.line || target.line || 1}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-info-800">
              {proposal.reason || 'QAAI found a safe generated-script patch. Review before applying.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md p-1 text-info-500 hover:bg-white hover:text-info-900 focus-visible:outline-none focus-visible:shadow-ring"
            aria-label="Discard repair preview"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-hidden rounded-lg border border-info-100 bg-ink-950 text-xs shadow-sm">
          <div className="border-b border-white/10 px-3 py-1.5 font-mono text-[11px] text-ink-300">
            line {target.line || proposal.line || 1}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono leading-5 text-danger-200">
            <span className="text-danger-400">- </span>{target.before || '(empty line)'}
          </pre>
          <pre className="overflow-x-auto whitespace-pre-wrap border-t border-white/10 px-3 py-2 font-mono leading-5 text-success-200">
            <span className="text-success-400">+ </span>{target.after || '(empty line)'}
          </pre>
        </div>

        {changed.length > 1 && (
          <div className="text-[11px] text-info-700">
            {changed.length} changed line{changed.length === 1 ? '' : 's'} in preview.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onApply} loading={applying} disabled={applying}>
            <Wand2 className="h-3.5 w-3.5" />
            Apply patch & rerun
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscard} disabled={applying}>
            Discard
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function OutputFilesAssistant({
  projectId,
  projectName,
  generationId,
  framework,
  frameworkLabel,
  bundleId,
  activeFile,
  fileList,
  report,
  running,
  disabled,
  repairingFailureId,
  onRunScripts,
  onProposeRepair,
  onRepairFailure,
  onBundlePatched,
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [repairProposal, setRepairProposal] = useState(null);
  const transcriptRef = useRef(null);
  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const repairableFailures = failures.filter((failure) => failure?.repairAvailable);
  const repairs = Array.isArray(report?.repairJournal?.repairs) ? report.repairJournal.repairs : [];
  const primaryFailure = repairableFailures[0] || failures[0] || null;
  const meta = statusMeta(report?.status);
  const StatusIcon = meta.icon;
  const badgeCount = failures.length || repairs.length || 0;
  const effectiveBundleId = report?.bundleId || bundleId || 'latest';
  const assistantThreadKey = useMemo(() => [
    'qaai-output-agent',
    projectId || 'project',
    generationId || 'current',
    effectiveBundleId,
    framework || 'replayir',
  ].join(':'), [effectiveBundleId, framework, generationId, projectId]);
  const contextLine = useMemo(() => [
    compact(projectName, 'No project'),
    `generation ${generationId ? shortId(generationId) : 'current'}`,
    `bundle ${shortId(effectiveBundleId)}`,
    compact(frameworkLabel, 'ReplayIR'),
    activeFile?.path ? tailPath(activeFile.path, 3) : 'no file selected',
  ].join(' | '), [activeFile?.path, effectiveBundleId, frameworkLabel, generationId, projectName]);
  const assistantContext = useMemo(() => ({
    primaryFailure,
    activeFile,
    fileList: Array.isArray(fileList) ? fileList : [],
    repairs,
    report,
  }), [activeFile, fileList, primaryFailure, repairs, report]);
  const seededMessage = useMemo(() => ({
    role: 'assistant',
    content: initialAssistantMessage({
      report,
      primaryFailure,
      activeFile,
      fileList: assistantContext.fileList,
    }),
  }), [activeFile, assistantContext.fileList, primaryFailure, report]);
  const visibleMessages = messages.length ? messages : [seededMessage];

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(assistantThreadKey);
      const parsed = saved ? JSON.parse(saved) : [];
      setMessages(Array.isArray(parsed) ? parsed.slice(-40) : []);
    } catch (_) {
      setMessages([]);
    }
  }, [assistantThreadKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (messages.length) {
        window.localStorage.setItem(assistantThreadKey, JSON.stringify(messages.slice(-40)));
      }
    } catch (_) {
      // Local chat persistence is best-effort.
    }
  }, [assistantThreadKey, messages]);

  const appendAssistant = (content) => {
    setMessages((items) => [...items, { role: 'assistant', content }]);
    window.setTimeout(() => {
      transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
    }, 0);
  };

  const assistantChatPath = () => {
    if (!projectId) return null;
    const params = new URLSearchParams({ source: 'replayir' });
    if (framework) params.set('framework', framework);
    if (generationId) params.set('generationId', generationId);
    return `/projects/${projectId}/output-files/${encodeURIComponent(effectiveBundleId)}/assistant/chat?${params.toString()}`;
  };

  const requestAssistantReply = async (content) => {
    const path = assistantChatPath();
    if (!path) {
      return 'I cannot read the generated output bundle yet because the current project or bundle is not loaded in this Output Files view.';
    }
    try {
      const res = await api.post(path, {
        message: content,
        activeFilePath: activeFile?.path || null,
        history: messages.slice(-12),
      });
      return res?.reply || 'I read the selected bundle, but the assistant did not return a usable answer. Try asking about a specific file path or line number.';
    } catch (err) {
      const msg = err?.payload?.message || err?.message || 'QAAI assistant backend is unavailable.';
      return [
        'I could not reach the Output Files assistant backend for this question.',
        '',
        `Reason: ${msg}`,
        '',
        activeFile?.path ? `Selected file: ${activeFile.path}` : 'No selected file is loaded.',
      ].join('\n');
    }
  };

  const patchLinePath = () => {
    if (!projectId) return null;
    const params = new URLSearchParams({ source: 'replayir' });
    if (framework) params.set('framework', framework);
    if (generationId) params.set('generationId', generationId);
    return `/projects/${projectId}/output-files/${encodeURIComponent(effectiveBundleId)}/assistant/patch-line?${params.toString()}`;
  };

  const rewriteFilePath = () => {
    if (!projectId) return null;
    const params = new URLSearchParams({ source: 'replayir' });
    if (framework) params.set('framework', framework);
    if (generationId) params.set('generationId', generationId);
    return `/projects/${projectId}/output-files/${encodeURIComponent(effectiveBundleId)}/assistant/rewrite-file?${params.toString()}`;
  };

  const createFilePath = () => {
    if (!projectId) return null;
    const params = new URLSearchParams({ source: 'replayir' });
    if (framework) params.set('framework', framework);
    if (generationId) params.set('generationId', generationId);
    return `/projects/${projectId}/output-files/${encodeURIComponent(effectiveBundleId)}/assistant/create-file?${params.toString()}`;
  };

  const applyLinePatchCommand = async (patch) => {
    const path = patchLinePath();
    if (!path) {
      appendAssistant('I cannot patch this line because the current project or bundle is not loaded.');
      return;
    }
    setChatBusy(true);
    try {
      const res = await api.post(path, patch);
      onBundlePatched?.(res);
      appendAssistant([
        'Line patch applied',
        `- File: ${res.file}`,
        `- Line: ${res.line}`,
        `- Before: ${res.beforeLine || '(empty line)'}`,
        `- After: ${res.afterLine || '(empty line)'}`,
        '- The change was journaled in the selected generated output bundle.',
      ].join('\n'));
    } catch (err) {
      appendAssistant(err?.payload?.message || err?.message || 'I could not apply that generated-file line patch.');
    } finally {
      setChatBusy(false);
    }
  };

  const applyFullFileRewriteCommand = async (rewrite) => {
    const path = rewriteFilePath();
    if (!path) {
      appendAssistant('I cannot rewrite this file because the current project or bundle is not loaded.');
      return;
    }
    setChatBusy(true);
    try {
      const res = await api.post(path, {
        file: rewrite.file,
        replacement: rewrite.replacement,
        instruction: rewrite.instruction,
        activeFilePath: activeFile?.path || null,
      });
      onBundlePatched?.({ ...res, line: null });
      appendAssistant([
        'Generated file rewritten',
        `- File: ${res.file}`,
        `- Lines: ${res.beforeLineCount} -> ${res.afterLineCount}`,
        '- The rewrite was applied inside the selected Output Files bundle and recorded in the repair journal.',
        '- Run scripts next if you want certification evidence for this rewritten bundle.',
      ].join('\n'));
    } catch (err) {
      appendAssistant(err?.payload?.message || err?.message || 'I could not rewrite that generated output file.');
    } finally {
      setChatBusy(false);
    }
  };

  const applyCreateFileCommand = async (createRequest) => {
    const path = createFilePath();
    if (!path) {
      appendAssistant('I cannot create a generated file because the current project or bundle is not loaded.');
      return;
    }
    setChatBusy(true);
    try {
      const res = await api.post(path, {
        file: createRequest.file || null,
        content: createRequest.content || null,
        instruction: createRequest.instruction,
        activeFilePath: activeFile?.path || null,
      });
      onBundlePatched?.({ ...res, line: null });
      appendAssistant([
        'Generated file created',
        `- File: ${res.file}`,
        `- Lines: ${res.lineCount || 'unknown'}`,
        '- I wrote it into the selected Output Files bundle and recorded it in the repair journal.',
        '- Run scripts next to validate this file before treating it as certified output.',
      ].join('\n'));
    } catch (err) {
      appendAssistant(err?.payload?.message || err?.message || 'I could not create that generated output file.');
    } finally {
      setChatBusy(false);
    }
  };

  const submitMessage = async (text, source = 'typed') => {
    const content = String(text || draft || '').trim();
    if (!content || chatBusy) return;
    if (source === 'typed') setMessages((items) => [...items, { role: 'user', content }]);
    setDraft('');
    const command = content.toLowerCase().replace(/\s+/g, ' ').trim();
    const createFile = parseCreateFileCommand(content);
    if (createFile) {
      applyCreateFileCommand(createFile);
      return;
    }
    const fullRewrite = parseFullFileRewriteCommand(content, activeFile?.path);
    if (fullRewrite) {
      applyFullFileRewriteCommand(fullRewrite);
      return;
    }
    const linePatch = parseLinePatchCommand(content, activeFile?.path);
    if (linePatch) {
      applyLinePatchCommand(linePatch);
      return;
    }
    if (command === '/run scripts' || command === 'run scripts') {
      onRunScripts?.();
      appendAssistant([
        'Script validation started',
        '- I triggered the QAAI script runner for this selected output bundle.',
        '- It runs separately from the live Conductor and will update certification, failures, traces, and repair evidence when complete.',
      ].join('\n'));
      return;
    }
    if (command === '/preview repair' || command === 'preview repair') {
      previewRepair();
      return;
    }
    if (command === '/apply patch' || command === 'apply patch') {
      applyRepairProposal();
      return;
    }
    setChatBusy(true);
    const reply = await requestAssistantReply(content);
    appendAssistant(reply);
    setChatBusy(false);
  };

  const previewRepair = async () => {
    if (!primaryFailure?.repairAvailable || !onProposeRepair || proposalBusy) return;
    setProposalBusy(true);
    try {
      const proposal = await onProposeRepair(primaryFailure);
      if (proposal) {
        setRepairProposal(proposal);
        appendAssistant([
          'Repair preview ready',
          `- File: ${proposal.file || primaryFailure.file}`,
          `- Line: ${proposal.line || primaryFailure.line || 1}`,
          '- Review the diff card, then apply the patch to rerun the failed scope.',
        ].join('\n'));
      } else {
        appendAssistant('No safe generated-file patch proposal was returned for this failure.');
      }
    } catch (err) {
      appendAssistant(err?.payload?.message || err?.message || 'QAAI could not produce a safe repair preview for this failure.');
    } finally {
      setProposalBusy(false);
    }
  };

  const applyRepairProposal = async () => {
    if (!primaryFailure || !repairProposal || !onRepairFailure) return;
    await onRepairFailure(primaryFailure, repairProposal);
    setRepairProposal(null);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed bottom-8 right-8 z-[1000] flex max-w-[calc(100vw-4rem)] flex-col items-end max-sm:bottom-4 max-sm:right-4 max-sm:max-w-[calc(100vw-2rem)]">
      {open && (
        <section
          className="mb-4 flex overflow-hidden rounded-2xl border border-white/80 bg-white/96 shadow-[0_28px_90px_rgba(15,23,42,0.24)] backdrop-blur-xl"
          style={{
            width: 'min(640px, calc(100vw - 4rem))',
            minWidth: 'min(430px, calc(100vw - 2rem))',
            height: 'min(720px, calc(100dvh - 9rem))',
            minHeight: '520px',
            maxHeight: 'calc(100dvh - 9rem)',
            resize: 'both',
          }}
        >
          <div className="flex min-h-0 w-full flex-col">
            <header className="flex items-start gap-3 border-b border-ink-100 px-5 py-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white">
                <Bot className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-ink-950">Claude Output Agent</h2>
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
                    <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {meta.label}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-ink-500" title={contextLine}>{contextLine}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-ring"
                aria-label="Close Claude Output Agent"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>

            {primaryFailure && (
              <div className="border-b border-danger-100 bg-danger-50/70 px-5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-danger-600" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-danger-800" title={`${primaryFailure.file || 'unknown'}:${primaryFailure.line || 1}`}>
                      Active failure: {primaryFailure.file || 'unknown file'}:{primaryFailure.line || 1}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <RepairProposalCard
              proposal={repairProposal}
              applying={repairingFailureId === primaryFailure?.id}
              onApply={applyRepairProposal}
              onDiscard={() => setRepairProposal(null)}
            />

            <div ref={transcriptRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-gradient-to-b from-ink-50/35 to-white px-6 py-5">
              {visibleMessages.map((message, index) => (
                <ChatBubble key={`${message.role}-${index}-${message.content.slice(0, 16)}`} message={message} />
              ))}
            </div>

            <div className="border-t border-ink-100 bg-white px-5 py-4">
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitMessage();
                }}
              >
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submitMessage();
                    }
                  }}
                  rows={3}
                  className="min-h-[84px] flex-1 resize-none rounded-xl border border-ink-200 bg-white px-4 py-3 text-sm leading-6 text-ink-800 shadow-sm outline-none transition placeholder:text-ink-400 focus:border-info-400 focus:shadow-ring"
                  placeholder={chatBusy ? 'Claude is reading the selected bundle...' : 'Ask about this bundle, selected file, code lines, missing steps, test data, locators, or script repairs.'}
                  disabled={chatBusy}
                />
                <button
                  type="submit"
                  className="flex h-[84px] w-14 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white transition hover:bg-ink-800 focus-visible:outline-none focus-visible:shadow-ring disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!draft.trim() || chatBusy}
                  aria-label="Send message"
                >
                  {chatBusy ? <Sparkles className="h-4 w-4 animate-pulse" aria-hidden="true" /> : <SendHorizontal className="h-4 w-4" aria-hidden="true" />}
                </button>
              </form>
              <div className="mt-2 text-[11px] text-ink-400">Current bundle only. I can read files, patch generated lines, run scripts, and explain validation evidence.</div>
            </div>
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group relative flex h-14 w-14 items-center justify-center rounded-full bg-ink-900 text-white shadow-[0_18px_45px_rgba(15,23,42,0.28)] transition-all hover:-translate-y-0.5 hover:bg-ink-800 focus-visible:outline-none focus-visible:shadow-ring"
        aria-label={open ? 'Collapse Claude Output Agent' : 'Open Claude Output Agent'}
        title={open ? 'Collapse Claude Output Agent' : 'Open Claude Output Agent'}
      >
        {open ? <ChevronDown className="h-5 w-5" aria-hidden="true" /> : <Bot className="h-5 w-5" aria-hidden="true" />}
        {badgeCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-danger-600 px-1.5 text-[11px] font-black text-white">
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
        {repairableFailures.length > 0 && (
          <span className="absolute inset-0 rounded-full border border-danger-300 opacity-70 animate-ping" aria-hidden="true" />
        )}
      </button>
    </div>,
    document.body,
  );
}
