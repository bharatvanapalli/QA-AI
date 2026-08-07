import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const actionLocatorResolver = require('../../server/services/actionLocatorResolver');
const locatorIntelligenceV2 = require('../../server/services/locatorIntelligenceV2');
const chaosEvaluation = require('../../server/services/locatorChaosEvaluation');

function installVisibleLayout(dom) {
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 32, width: 120, height: 32 };
    },
  });
}

async function captureStructuralLocatorFromDom(html, targetSelector, options = {}) {
  const dom = new JSDOM(html);
  installVisibleLayout(dom);
  if (typeof options.prepare === 'function') options.prepare(dom);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const target = typeof targetSelector === 'function'
    ? targetSelector(dom)
    : dom.window.document.querySelector(targetSelector);
  expect(target).toBeTruthy();

  try {
    const session = {
      client: {
        callTool: async (call) => {
          const fn = eval(call.arguments.function);
          const result = fn(target);
          return { content: [{ type: 'text', text: `Result: ${JSON.stringify(result)}` }] };
        },
      },
    };
    return await actionLocatorResolver.captureStructuralLocator({
      session,
      ref: options.ref || 'e42',
      element: options.element || 'target',
      pageUrl: options.pageUrl || 'https://chaos.test/users',
      toolName: options.toolName || 'browser_click',
      contractStepId: options.contractStepId || 'chaos.step.structural',
      actionOccurrenceId: options.actionOccurrenceId || 'chaos.action.structural.1',
      sequenceIndex: options.sequenceIndex ?? 1,
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

async function captureStructuralLocatorFromFrameDom(parentHtml, frameSelector, frameHtml, targetSelector) {
  const parentDom = new JSDOM(parentHtml);
  const frameDom = new JSDOM(frameHtml, { url: 'https://chaos.test/frame' });
  installVisibleLayout(parentDom);
  installVisibleLayout(frameDom);
  const frameElement = parentDom.window.document.querySelector(frameSelector);
  expect(frameElement).toBeTruthy();
  Object.defineProperty(frameDom.window, 'frameElement', {
    configurable: true,
    value: frameElement,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = frameDom.window;
  globalThis.document = frameDom.window.document;
  const target = frameDom.window.document.querySelector(targetSelector);
  expect(target).toBeTruthy();

  try {
    const session = {
      client: {
        callTool: async (call) => {
          const fn = eval(call.arguments.function);
          const result = fn(target);
          return { content: [{ type: 'text', text: `Result: ${JSON.stringify(result)}` }] };
        },
      },
    };
    return await actionLocatorResolver.captureStructuralLocator({
      session,
      ref: 'frame-e42',
      element: targetSelector,
      pageUrl: 'https://chaos.test/host',
      toolName: 'browser_click',
      contractStepId: 'chaos.step.frame',
      actionOccurrenceId: 'chaos.action.frame.1',
      sequenceIndex: 1,
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    frameDom.window.close();
    parentDom.window.close();
  }
}

async function captureCoordinateLocatorFromDom(html, targetSelector, args = { x: 32, y: 48 }) {
  const dom = new JSDOM(html);
  installVisibleLayout(dom);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const target = dom.window.document.querySelector(targetSelector);
  expect(target).toBeTruthy();
  dom.window.document.elementFromPoint = () => target;

  try {
    const session = {
      client: {
        callTool: async (call) => {
          const fn = eval(call.arguments.function);
          const result = fn();
          return { content: [{ type: 'text', text: `Result: ${JSON.stringify(result)}` }] };
        },
      },
    };
    return await actionLocatorResolver.captureCoordinateLocator({
      session,
      toolName: 'browser_click_xy',
      args,
      element: 'visual save',
      pageUrl: 'https://chaos.test/visual',
      contractStepId: 'chaos.step.coordinate',
      actionOccurrenceId: 'chaos.action.coordinate.1',
      sequenceIndex: 1,
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

function buttonInRow(dom, text) {
  return [...dom.window.document.querySelectorAll('tr')]
    .find((row) => row.textContent.includes(text))
    ?.querySelector('button');
}

function locatorFingerprint(actionLocator, elementLabel) {
  return locatorIntelligenceV2.buildLocatorEvidenceBundle({
    actionLocator,
    toolName: 'browser_click',
    elementLabel,
    pageUrl: 'https://chaos.test/users',
  }).fingerprint;
}

describe('locator chaos evaluation', () => {
  it('scores resilient mutations and blocked repair paths without silent greens', async () => {
    const stableBefore = await captureStructuralLocatorFromDom(`
      <main>
        <button id="volatile-101" class="btn session-a" data-testid="save-user">Save user</button>
      </main>
    `, 'button', { element: 'Save user before churn' });
    const stableAfter = await captureStructuralLocatorFromDom(`
      <main>
        <button id="volatile-909" class="btn session-z" data-testid="save-user">Save user</button>
      </main>
    `, 'button', { element: 'Save user after churn' });
    const rowBefore = await captureStructuralLocatorFromDom(`
      <table>
        <tbody>
          <tr class="row-a"><td>Alice Admin</td><td><button class="x1">Edit</button></td></tr>
          <tr class="row-b"><td>Bob Builder</td><td><button class="x2">Edit</button></td></tr>
        </tbody>
      </table>
    `, (dom) => buttonInRow(dom, 'Bob Builder'), { element: 'Edit Bob before reorder' });
    const rowAfter = await captureStructuralLocatorFromDom(`
      <table>
        <tbody>
          <tr class="row-random-88"><td>Bob Builder</td><td><button class="changed">Edit</button></td></tr>
          <tr class="row-random-11"><td>Alice Admin</td><td><button class="changed">Edit</button></td></tr>
        </tbody>
      </table>
    `, (dom) => buttonInRow(dom, 'Bob Builder'), { element: 'Edit Bob after reorder' });
    const coordinateRescue = await captureCoordinateLocatorFromDom(`
      <main>
        <button data-testid="visual-save">Save</button>
      </main>
    `, 'button');
    const frameStable = await captureStructuralLocatorFromFrameDom(
      '<main><iframe id="checkout-frame" title="Checkout"></iframe></main>',
      'iframe',
      '<button>Pay now</button>',
      'button'
    );
    const frameUnstable = await captureStructuralLocatorFromFrameDom(
      '<main><iframe></iframe></main>',
      'iframe',
      '<button>Pay now</button>',
      'button'
    );
    const coordinateGap = actionLocatorResolver.coordinateGap({
      toolName: 'browser_click_xy',
      args: { x: 99, y: 101 },
      pageUrl: 'https://chaos.test/visual',
      elementLabel: 'visual target',
      detail: 'Coordinate rescue could not map the point back to a DOM element.',
    });

    const report = chaosEvaluation.buildChaosEvaluationReport({
      suiteName: 'Phase 8 locator chaos suite',
      metadata: { mode: 'deterministic-jsdom' },
      cases: [
        { name: 'stable attribute survives class/id churn before', category: 'attribute-churn', mutation: 'volatile class and id', actionLocator: stableBefore, elementLabel: 'Save user' },
        { name: 'stable attribute survives class/id churn after', category: 'attribute-churn', mutation: 'volatile class and id', actionLocator: stableAfter, elementLabel: 'Save user' },
        { name: 'row scope survives DOM reorder before', category: 'row-reorder', mutation: 'duplicate button labels', actionLocator: rowBefore, elementLabel: 'Edit Bob' },
        { name: 'row scope survives DOM reorder after', category: 'row-reorder', mutation: 'duplicate button labels plus reordered rows', actionLocator: rowAfter, elementLabel: 'Edit Bob' },
        { name: 'coordinate rescue converts to DOM locator', category: 'vision-coordinate', mutation: 'coordinate-only action', toolName: 'browser_click_xy', actionLocator: coordinateRescue, elementLabel: 'visual save' },
        { name: 'stable frame locator survives iframe boundary', category: 'frame', mutation: 'iframe boundary', actionLocator: frameStable, elementLabel: 'Pay now' },
        { name: 'unstable frame blocks instead of exporting blind locator', category: 'frame', mutation: 'iframe has no stable selector', actionLocator: frameUnstable, expected: 'blocked', gap: { code: 'locator_unrecoverable', reason: 'iframe selector was not stable enough to certify.' } },
        { name: 'coordinate conversion failure blocks with repair evidence', category: 'vision-coordinate', mutation: 'coordinate cannot convert', expected: 'blocked', gap: coordinateGap },
      ],
    });

    expect(report.schemaVersion).toBe(chaosEvaluation.CHAOS_EVALUATION_SCHEMA_VERSION);
    expect(report.summary).toMatchObject({
      total: 8,
      survived: 6,
      blocked: 2,
      failed: 0,
      silentGreens: 0,
      status: 'guarded',
    });
    expect(report.summary.safetyRate).toBe(100);
    expect(report.cases.filter((item) => item.outcome === 'survived').every((item) => item.exportSafe)).toBe(true);
    expect(report.cases.some((item) => item.gap?.code === 'locator_unverified')).toBe(true);
    expect(() => chaosEvaluation.assertChaosReportPassed(report)).not.toThrow();
  });

  it('matches fingerprints across DOM reorder and volatile class changes', async () => {
    const before = await captureStructuralLocatorFromDom(`
      <table>
        <tbody>
          <tr class="generated-a"><td>Alice Admin</td><td><button>Edit</button></td></tr>
          <tr class="generated-b"><td>Bob Builder</td><td><button>Edit</button></td></tr>
        </tbody>
      </table>
    `, (dom) => buttonInRow(dom, 'Bob Builder'), { element: 'Edit Bob before reorder' });
    const after = await captureStructuralLocatorFromDom(`
      <table>
        <tbody>
          <tr class="next-build-b"><td>Bob Builder</td><td><button>Edit</button></td></tr>
          <tr class="next-build-a"><td>Alice Admin</td><td><button>Edit</button></td></tr>
        </tbody>
      </table>
    `, (dom) => buttonInRow(dom, 'Bob Builder'), { element: 'Edit Bob after reorder' });

    const beforeExpr = before.frameworkExpressions.playwright;
    const afterExpr = after.frameworkExpressions.playwright;
    expect(beforeExpr).toMatch(/Bob Builder\s*Edit/);
    expect(afterExpr).toMatch(/Bob Builder\s*Edit/);
    expect(beforeExpr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);
    expect(afterExpr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);

    const match = locatorIntelligenceV2.scoreFingerprintMatch(
      locatorFingerprint(before, 'Edit Bob'),
      locatorFingerprint(after, 'Edit Bob')
    );

    expect(match.matched).toBe(true);
    expect(match.score).toBeGreaterThanOrEqual(80);
  });

  it('fails the report when a chaos case would silently certify a broken locator', () => {
    const brokenCertified = {
      locatorEvidenceV2: {
        exportGate: { status: 'certified' },
        selected: {
          expression: 'getByRole("button", { name: "Save" })',
          confidence: 'certified',
          proof: { count: 2, sameElement: false },
        },
      },
      expected: 'blocked',
      name: 'synthetic silent green',
    };

    const report = chaosEvaluation.buildChaosEvaluationReport({ cases: [brokenCertified] });

    expect(report.summary.status).toBe('failed');
    expect(report.summary.silentGreens).toBe(1);
    expect(report.findings[0].rule).toBe('chaos_silent_green');
    expect(() => chaosEvaluation.assertChaosReportPassed(report)).toThrow(/silent green/i);
  });
});
