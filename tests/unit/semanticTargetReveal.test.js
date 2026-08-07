import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import reveal from '../../server/services/semanticTargetReveal.js';

function runReveal(html, request, configure) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1200 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 800 });
  configure?.(dom.window);
  const source = reveal.buildSemanticTargetRevealFunction(request);
  const execute = dom.window.eval(`(${source})`);
  return JSON.parse(execute());
}

describe('semantic target reveal', () => {
  it('reveals the unique labelled date owner exactly once', () => {
    const scrollEarly = vi.fn();
    const scrollLate = vi.fn();
    const result = runReveal(`
      <label for="early">Early Pickup Date</label>
      <input id="early" type="text" />
      <label for="late">Late Pickup Date</label>
      <input id="late" type="text" />
    `, {
      label: 'Early Pickup Date',
      roleHints: ['textbox', 'combobox', 'button'],
      semanticTarget: { kind: 'control_opener', controlKind: 'date' },
    }, (window) => {
      const early = window.document.getElementById('early');
      const late = window.document.getElementById('late');
      let earlyTop = 1400;
      early.getBoundingClientRect = () => ({ top: earlyTop, bottom: earlyTop + 40, left: 20, right: 320, width: 300, height: 40 });
      late.getBoundingClientRect = () => ({ top: 1500, bottom: 1540, left: 20, right: 320, width: 300, height: 40 });
      early.scrollIntoView = (...args) => { scrollEarly(...args); earlyTop = 300; };
      late.scrollIntoView = scrollLate;
      for (const label of window.document.querySelectorAll('label')) {
        label.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 180, width: 170, height: 20 });
      }
    });

    expect(result).toMatchObject({ ok: true, reason: 'semantic_target_revealed', role: 'textbox', visible: true });
    expect(scrollEarly).toHaveBeenCalledTimes(1);
    expect(scrollLate).not.toHaveBeenCalled();
  });

  it('does not scroll when the semantic target is genuinely ambiguous', () => {
    const scroll = vi.fn();
    const result = runReveal(`
      <label for="first">Pickup Date</label><input id="first" type="text" />
      <label for="second">Pickup Date</label><input id="second" type="text" />
    `, {
      label: 'Pickup Date',
      roleHints: ['textbox'],
      semanticTarget: { kind: 'control_opener', controlKind: 'date' },
    }, (window) => {
      for (const node of window.document.querySelectorAll('input, label')) {
        node.getBoundingClientRect = () => ({ top: 1200, bottom: 1240, left: 20, right: 320, width: 300, height: 40 });
        node.scrollIntoView = scroll;
      }
    });

    expect(result).toMatchObject({ ok: false, reason: 'semantic_target_ambiguous', candidateCount: 2 });
    expect(scroll).not.toHaveBeenCalled();
  });

  it('reveals a generic Date field by combining its local label and group heading', () => {
    const scrollDate = vi.fn();
    const scrollTime = vi.fn();
    const result = runReveal(`
      <section>
        <div>Early Pickup Date and Time</div>
        <div><span>Date</span><input id="pickup-date" type="text" readonly /></div>
        <div><span>Time</span><input id="pickup-time" type="text" readonly /></div>
      </section>
      <section>
        <div>Early Delivery Date and Time</div>
        <div><span>Date</span><input id="delivery-date" type="text" readonly /></div>
      </section>
    `, {
      label: 'Early Pickup Date calendar',
      roleHints: ['textbox', 'combobox', 'button'],
      semanticTarget: { kind: 'control_opener', controlKind: 'calendar' },
    }, (window) => {
      for (const node of window.document.querySelectorAll('*')) {
        node.getBoundingClientRect = () => ({ top: 1100, bottom: 1140, left: 20, right: 320, width: 300, height: 40 });
      }
      const pickupDate = window.document.getElementById('pickup-date');
      const pickupTime = window.document.getElementById('pickup-time');
      let pickupDateTop = 1100;
      pickupDate.getBoundingClientRect = () => ({ top: pickupDateTop, bottom: pickupDateTop + 40, left: 20, right: 320, width: 300, height: 40 });
      pickupDate.scrollIntoView = (...args) => { scrollDate(...args); pickupDateTop = 300; };
      pickupTime.scrollIntoView = scrollTime;
    });

    expect(result).toMatchObject({ ok: true, reason: 'semantic_target_revealed', role: 'textbox' });
    expect(scrollDate).toHaveBeenCalledTimes(1);
    expect(scrollTime).not.toHaveBeenCalled();
  });

  it('binds a uniquely revealed node temporarily and restores its original accessibility identity', () => {
    const dom = new JSDOM(`
      <section>
        <div>Early Pickup Date and Time</div>
        <div><span>Date</span><input id="pickup-date" aria-label="Date" type="text" readonly /></div>
      </section>
    `, { runScripts: 'outside-only' });
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 800 });
    for (const node of dom.window.document.querySelectorAll('*')) {
      node.getBoundingClientRect = () => ({ top: 200, bottom: 240, left: 20, right: 320, width: 300, height: 40 });
    }
    const input = dom.window.document.getElementById('pickup-date');
    input.scrollIntoView = vi.fn();

    const revealSource = reveal.buildSemanticTargetRevealFunction({
      label: 'Early Pickup Date',
      roleHints: ['textbox', 'combobox', 'button'],
      semanticTarget: { kind: 'control_opener', controlKind: 'date' },
    });
    const revealed = JSON.parse(dom.window.eval(`(${revealSource})`)());

    expect(revealed.runtimeBinding).toMatchObject({ hadAriaLabel: true, previousAriaLabel: 'Date' });
    expect(revealed.runtimeBinding.marker).toMatch(/^qaai-runtime-[a-z0-9-]+$/i);
    expect(revealed.runtimeBinding.marker).not.toContain('pickup');
    expect(input.getAttribute('aria-label')).toBe('Early Pickup Date');

    const releaseSource = reveal.buildSemanticTargetReleaseFunction(revealed.runtimeBinding);
    const released = JSON.parse(dom.window.eval(`(${releaseSource})`)());
    expect(released).toMatchObject({ ok: true, reason: 'runtime_binding_released' });
    expect(input.getAttribute('aria-label')).toBe('Date');
    expect(input.hasAttribute('data-qaai-runtime-target')).toBe(false);
  });

  it('rejects a target that is replaced during scroll instead of accepting stale identity', () => {
    const result = runReveal(`
      <label for="pickup">Pickup Date</label><input id="pickup" type="text" />
    `, {
      label: 'Pickup Date',
      roleHints: ['textbox'],
      semanticTarget: { kind: 'control_opener', controlKind: 'date' },
    }, (window) => {
      const input = window.document.getElementById('pickup');
      input.getBoundingClientRect = () => ({ top: 1200, bottom: 1240, left: 20, right: 320, width: 300, height: 40 });
      input.scrollIntoView = () => input.remove();
      const label = window.document.querySelector('label');
      label.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 180, width: 170, height: 20 });
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'semantic_target_changed_during_reveal',
      identityPreserved: false,
    });
  });

  it('keeps temporal identity tokens while removing surface words', () => {
    expect(reveal.identityTokens('Early Pickup Date calendar opener')).toEqual(['early', 'pickup']);
  });
});
