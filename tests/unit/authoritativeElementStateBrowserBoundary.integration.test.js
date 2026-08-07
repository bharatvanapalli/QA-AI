import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const capture = require('../../server/services/authoritativeCdpCapture.js');

const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MARKER_ATTRIBUTE = 'data-qaai-state-boundary';

async function captureElement(page, locator, markerValue) {
  await locator.evaluate((element, marker) => element.setAttribute(marker.attribute, marker.value), {
    attribute: MARKER_ATTRIBUTE,
    value: markerValue,
  });
  try {
    return await capture.captureMarkedTarget({
      page,
      markerAttribute: MARKER_ATTRIBUTE,
      markerValue,
      phase: 'pre_action',
    });
  } finally {
    await locator.evaluate((element, attribute) => element.removeAttribute(attribute), MARKER_ATTRIBUTE)
      .catch(() => {});
  }
}

describe('authoritative element state real Chromium boundary', () => {
  let browser;
  const contexts = new Set();

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(SYSTEM_CHROME) ? { executablePath: SYSTEM_CHROME } : {}),
    });
  }, 60_000);

  afterEach(async () => {
    const active = Array.from(contexts);
    contexts.clear();
    await Promise.allSettled(active.map((context) => context.close()));
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it('captures exact native, contenteditable, and custom-control operation semantics', async () => {
    const context = await browser.newContext();
    contexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <style>
        [contenteditable], [role="button"], [role="checkbox"], [role="combobox"] {
          display: inline-block; min-width: 80px; min-height: 24px;
        }
      </style>
      <div id="editable-empty" contenteditable=""></div>
      <div id="editable-plain" contenteditable="plaintext-only"></div>
      <div contenteditable="true"><span id="editable-inherited">Inherited editor</span></div>
      <div id="custom-disabled-attribute" role="button" disabled tabindex="0">Custom action</div>
      <fieldset disabled><input id="fieldset-disabled" type="text" value="locked"></fieldset>
      <input id="readonly-text" type="text" readonly value="A-100">
      <input id="readonly-checkbox" type="checkbox" readonly>
      <div id="readonly-custom-check" role="checkbox" aria-readonly="true" tabindex="0">Check</div>
      <input id="color-input" type="color" value="#336699">
      <input id="range-input" type="range" min="0" max="10" value="5">
      <input id="file-input" type="file">
      <select id="native-select"><option>One</option></select>
      <div id="custom-combobox" role="combobox" aria-expanded="false" tabindex="0">One</div>
    `, { waitUntil: 'domcontentloaded' });

    const captured = {};
    for (const id of [
      'editable-empty', 'editable-plain', 'editable-inherited', 'custom-disabled-attribute',
      'fieldset-disabled', 'readonly-text', 'readonly-checkbox', 'readonly-custom-check',
      'color-input', 'range-input', 'file-input', 'native-select', 'custom-combobox',
    ]) {
      captured[id] = await captureElement(page, page.locator(`#${id}`), id);
      expect(captured[id]).toMatchObject({ captured: true, authoritative: true });
      expect(captured[id].domState).toMatchObject({
        available: true,
        source: 'runtime_exact_node',
        isConnected: true,
      });
      expect(captured[id].state.proof.domState).toBe('verified');
    }

    for (const id of ['editable-empty', 'editable-plain', 'editable-inherited']) {
      expect(captured[id].domState.isContentEditable).toBe(true);
      expect(captured[id].state).toMatchObject({ editable: true, actionableBy: { fill: true } });
    }
    expect(captured['custom-disabled-attribute']).toMatchObject({
      domState: { matchesDisabled: false, disabledProperty: null },
      state: { disabled: false, enabled: true, actionableBy: { click: true } },
    });
    expect(captured['fieldset-disabled']).toMatchObject({
      domState: { matchesDisabled: true, disabledProperty: false },
      state: { disabled: true, enabled: false, actionableBy: { fill: false } },
    });
    expect(captured['readonly-text'].state).toMatchObject({
      readOnly: true,
      editable: false,
      actionableBy: { fill: false },
    });
    expect(captured['readonly-checkbox']).toMatchObject({
      domState: { readOnlyProperty: true },
      state: { readOnly: false, actionableBy: { check: true } },
    });
    expect(captured['readonly-custom-check'].state).toMatchObject({
      readOnly: true,
      actionableBy: { click: true, check: false },
    });
    expect(captured['color-input'].state.actionableBy).toMatchObject({ fill: true, setInputFiles: false });
    expect(captured['range-input'].state.actionableBy).toMatchObject({ fill: true, setInputFiles: false });
    expect(captured['file-input'].state.actionableBy).toMatchObject({ fill: false, setInputFiles: true });
    expect(captured['native-select'].state.actionableBy).toMatchObject({ select: true, semanticSelect: true });
    expect(captured['custom-combobox'].state.actionableBy).toMatchObject({ select: false, semanticSelect: true });
  }, 120_000);

  it('proves unobstructed, occluded, pointer-free-fill, and inert action points', async () => {
    const context = await browser.newContext();
    contexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <style>
        #covered-wrap { position: relative; display: inline-block; }
        #cover { position: absolute; inset: 0; z-index: 3; background: rgba(0,0,0,.01); }
        button, input { width: 180px; height: 36px; margin: 8px; }
      </style>
      <button id="unobstructed">Save</button>
      <span id="covered-wrap"><button id="covered">Delete</button><span id="cover"></span></span>
      <input id="pointer-free-fill" type="text" style="pointer-events:none" value="">
      <div inert><button id="inert-button">Inert action</button></div>
    `, { waitUntil: 'domcontentloaded' });

    const unobstructed = await captureElement(page, page.locator('#unobstructed'), 'unobstructed');
    const covered = await captureElement(page, page.locator('#covered'), 'covered');
    const pointerFreeFill = await captureElement(page, page.locator('#pointer-free-fill'), 'pointer-free-fill');
    const inert = await captureElement(page, page.locator('#inert-button'), 'inert-button');

    expect(unobstructed).toMatchObject({
      domState: { available: true, localHitTest: { available: true, targetOrDescendant: true } },
      pointerHitTest: { available: true, targetOrDescendant: true, occluded: false },
      state: { actionableBy: { click: true, hover: true } },
    });
    expect(covered).toMatchObject({
      domState: { available: true, localHitTest: { available: true, targetOrDescendant: false } },
      pointerHitTest: { available: true, targetOrDescendant: false, occluded: true },
      state: { actionableBy: { click: false, hover: false } },
    });
    expect(pointerFreeFill).toMatchObject({
      domState: { pointerEvents: 'none' },
      state: { editable: true, actionableBy: { click: false, fill: true, hover: false } },
    });
    expect(inert).toMatchObject({
      domState: { effectiveInert: true },
      state: { inert: true, actionableBy: { click: false, hover: false } },
    });
  }, 120_000);
});
