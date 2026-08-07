import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');

function standardMap(entries = []) {
  const map = new Map(entries);
  map.__standardJsOutput = true;
  map.__methodNames = new Map();
  map.__pagesMethods = new Map();
  map.__pageVars = ['workspacePage'];
  return map;
}

describe('Playwright POM Phase B renderer contract', () => {
  test.each([
    ['url', { expected: 'https://external.example.test/ready' }, 'waitForURL'],
    ['visible', { target: 'status' }, "state: \"visible\""],
    ['hidden', { target: 'status' }, "state: \"hidden\""],
    ['enabled', { target: 'status' }, 'toBeEnabled'],
    ['disabled', { target: 'status' }, 'toBeDisabled'],
    ['text', { target: 'status', expected: 'Ready' }, 'toContainText("Ready"'],
    ['title', { expected: 'Arbitrary workspace' }, 'toHaveTitle("Arbitrary workspace"'],
    ['pageState', { expected: { effect: 'stable' } }, 'waitForLoadState("domcontentloaded"'],
    ['loadState', { expected: 'networkidle' }, 'waitForLoadState("networkidle"'],
    ['duration', { durationMs: 1337 }, 'waitForTimeout(1337)'],
  ])('renders executed %s waits without changing their semantic kind', (kind, extra, expectedSource) => {
    const map = standardMap([
      ['status', { file: 'WorkspacePage.js', pageVar: 'workspacePage', name: 'statusMessage' }],
    ]);
    const source = playwrightPom._emitPomWait({ kind, timeoutMs: 24619, ...extra }, map, map);
    expect(source).toContain(expectedSource);
    expect(source).not.toContain('QAAI_FALLBACK');
    if (kind === 'loadState') expect(source).not.toContain("waitForLoadState('load'");
  });

  test('enforces authored stability, polling, and bounded reload recovery', () => {
    const map = standardMap([
      ['status', { file: 'WorkspacePage.js', pageVar: 'workspacePage', name: 'statusMessage' }],
    ]);
    const source = playwrightPom._emitPomWait({
      kind: 'visible',
      target: 'status',
      timeoutMs: 24619,
      pollIntervalMs: 317,
      stableObservations: 3,
      refreshAfterMs: 7113,
      recovery: { action: 'reload', maxAttempts: 2, retryAfterMs: 2711, waitUntil: 'domcontentloaded' },
    }, map, map);
    expect(source).toContain('waitForStableObservations(page, {');
    expect(source).toContain('observations: 3');
    expect(source).toContain('pollIntervalMs: 317');
    expect(source).not.toContain('_qaaiStableDeadline');
    expect(source).toContain('const _qaaiRecoveryLimit = 2');
    expect(source).toContain('const _qaaiInitialRecoveryAfterMs = 7113');
    expect(source).toContain('const _qaaiRetryAfterMs = 2711');
    expect(source).toContain('page.reload({ timeout: _qaaiReloadBudget, waitUntil: "domcontentloaded" })');
    expect(source).not.toContain('.catch(() => {})');
  });

  test('preserves absolute cross-origin navigation and emits typed back, forward, and reload methods', () => {
    const url = 'https://login.external.example.test/path?tenant=arbitrary#ready';
    expect(playwrightPom._buildMethodBody('navigate', '', '', {
      step: { url, navigation: { timeoutMs: 18731, waitUntil: 'commit' } },
    })).toContain(`this.page.goto(${JSON.stringify(url)}, { waitUntil: "commit", timeout: 18731 })`);
    expect(playwrightPom._buildMethodBody('navigateBack', '', '', {
      step: { navigation: { timeoutMs: 18731, waitUntil: 'load' } },
    })).toContain('this.page.goBack({ waitUntil: "load", timeout: 18731 })');
    expect(playwrightPom._buildMethodBody('navigateForward', '', '', {
      step: { navigation: { timeoutMs: 18731, waitUntil: 'domcontentloaded' } },
    })).toContain('this.page.goForward({ waitUntil: "domcontentloaded", timeout: 18731 })');
    expect(playwrightPom._buildMethodBody('reload', '', '', {
      step: { navigation: { timeoutMs: 18731, waitUntil: 'networkidle' } },
    })).toContain('this.page.reload({ waitUntil: "networkidle", timeout: 18731 })');
  });

  test('inherits the generated test timeout when navigation has no authored timeout', () => {
    const source = playwrightPom._buildMethodBody('navigate', '', '', {
      step: { url: 'https://app.example.test/start' },
    });
    expect(source).toContain('this.page.goto("https://app.example.test/start", { waitUntil: "domcontentloaded" })');
    expect(source).not.toContain('timeout:');
  });

  test.each([
    ['popup', { selectedEvent: { url: 'https://external.example.test/popup' } }, "waitForEvent('popup'"],
    ['download', { selectedEvent: { suggestedFilename: 'report.csv' } }, "waitForEvent('download'"],
    ['dialog', { selectedEvent: { dialogType: 'confirm', message: 'Delete this record?' } }, "waitForEvent('dialog'"],
    ['navigation', { selectedEvent: { url: 'https://external.example.test/complete' } }, 'waitForURL'],
  ])('pre-arms the exact %s event occurrence before its trigger', (eventKind, event, expectedSource) => {
    const caseMap = standardMap([
      ['trigger', { file: 'WorkspacePage.js', pageVar: 'workspacePage', name: 'primaryActionButton' }],
    ]);
    const step = {
      op: 'act',
      action: 'click',
      target: 'trigger',
      targetLabel: 'Primary action',
      contractStepId: `event-${eventKind}`,
      actionOccurrenceId: `event-${eventKind}:click:1`,
      optional: true,
      timeoutMs: 17321,
      browserEventEvidence: {
        eventKind,
        status: 'confirmed',
        matched: true,
        timing: { timeoutMs: 17321 },
        expected: {},
        ...event,
      },
    };
    const source = playwrightPom._pomEmitAct(step, caseMap, false, null, caseMap, {}, { steps: [step] });
    expect(source).toContain(expectedSource);
    expect(source).toContain('workspacePage.clickPrimaryAction()');
    expect(source.indexOf("waitFor({ state: 'visible'")).toBeLessThan(source.indexOf(expectedSource));
    expect(source.indexOf(expectedSource)).toBeLessThan(source.indexOf('workspacePage.clickPrimaryAction()'));
  });

  test('round-trips continuation, proof, optional guard, and event metadata', () => {
    const browserEventEvidence = { eventKind: 'dialog', selectedEvent: { dialogType: 'confirm' } };
    const source = {
      action: 'click',
      continueIndependent: true,
      continueOnFailure: true,
      proofType: 'accessibility',
      visualCaptured: false,
      proofSource: 'dom_accessibility',
      actionGuard: { kind: 'ifVisible', timeoutMs: 2000, onFalse: 'skip' },
      dialogType: 'confirm',
      browserEventEvidence,
    };
    expect(playwrightPom._serializePageMethodStep('click', source)).toMatchObject(source);
  });
});
