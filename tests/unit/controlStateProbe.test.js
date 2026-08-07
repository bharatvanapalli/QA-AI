import { describe, expect, it } from 'vitest';
import probe from '../../server/services/controlStateProbe';

function runElementProbe(element, rect = null, options = {}) {
  element.getBoundingClientRect = () => rect || ({
    top: 0, left: 0, right: 120, bottom: 32, width: 120, height: 32,
  });
  return Function('return ' + probe.elementStateFunction(options))()(element);
}

describe('generic control state probe', () => {
  it('generates a website-neutral exact element probe', () => {
    const source = probe.elementStateFunction({ attributeNames: ['data-state', 'aria-current'] });
    expect(source).toContain('selectedTexts');
    expect(source).toContain('intersectionRatio');
    expect(source).toContain('tooltipTexts');
    expect(source).toContain('data-state');
    expect(source).not.toMatch(/microsoft|odyssey|google|salesforce/i);
  });

  it('preserves exact value and visible selection channels', () => {
    const observation = probe.buildControlObservation({
      kind: 'select',
      after: { selectedValue: 'CA', selectedText: 'Canada', selectedTexts: ['Canada'] },
    });
    expect(observation).toMatchObject({ selectedValue: 'CA', selectedText: 'Canada' });
  });

  it('keeps rendered visibility separate from current viewport intersection', () => {
    document.body.innerHTML = '<button>Continue</button>';
    const observation = runElementProbe(document.querySelector('button'), {
      top: 2000, left: 0, right: 120, bottom: 2032, width: 120, height: 32,
    });

    expect(observation.visible).toBe(true);
    expect(observation.inViewport).toBe(false);
    expect(observation.intersectionRatio).toBe(0);
  });

  it('reads an exact custom selection from aria-valuetext', () => {
    document.body.innerHTML = '<div role="combobox" aria-valuetext="Choice Alpha Extended">Choice Alpha</div>';
    const observation = runElementProbe(document.querySelector('[role="combobox"]'));

    expect(observation.selectedText).toBe('Choice Alpha Extended');
    expect(observation.selectedTexts).toEqual(['Choice Alpha Extended']);
    expect(observation.selectedText).not.toBe('Choice Alpha');
  });

  it('reads the exact aria-activedescendant text for a custom control', () => {
    document.body.innerHTML = [
      '<div role="combobox" aria-activedescendant="choice-beta"></div>',
      '<div id="choice-beta" role="option">Choice Beta</div>',
    ].join('');
    const observation = runElementProbe(document.querySelector('[role="combobox"]'));

    expect(observation.selectedValue).toBe('Choice Beta');
    expect(observation.selectedText).toBe('Choice Beta');
  });

  it('reads rendered selected text from a closed semantic combobox', () => {
    document.body.innerHTML = '<span role="combobox" aria-label="Ship Direction">Inbound</span>';
    const observation = runElementProbe(document.querySelector('[role="combobox"]'));

    expect(observation.selectedValue).toBe('Inbound');
    expect(observation.selectedText).toBe('Inbound');
    expect(observation.selectedTexts).toEqual(['Inbound']);
  });

  it('derives expanded state from a generic expanded disclosure owner', () => {
    document.body.innerHTML = '<section class="disclosure disclosure--expanded"><button>Planning dates</button></section>';
    const observation = runElementProbe(document.querySelector('button'), null, { attributeNames: ['expanded'] });

    expect(observation.expanded).toBe(true);
    expect(observation.attributes.expanded).toBe(true);
  });

  it('uses only one unique aria-selected descendant', () => {
    document.body.innerHTML = [
      '<div id="single" role="listbox"><div role="option" aria-selected="true">Choice Gamma</div></div>',
      '<div id="ambiguous" role="listbox">',
      '  <div role="option" aria-selected="true">Choice Delta</div>',
      '  <div role="option" aria-selected="true">Choice Epsilon</div>',
      '</div>',
    ].join('');

    expect(runElementProbe(document.getElementById('single')).selectedText).toBe('Choice Gamma');
    expect(runElementProbe(document.getElementById('ambiguous'))).toMatchObject({
      selectedText: null,
      selectedTexts: [],
    });
  });

  it('projects scroll deltas on the requested axis', () => {
    expect(probe.buildControlObservation({
      kind: 'scroll', before: { scrollY: 100 }, after: { scrollY: 500, maxScrollY: 900 },
    })).toMatchObject({ before: 100, after: 500, max: 900 });
  });

  it('parses direct objects and serialized evaluate results', () => {
    expect(probe.parseProbeResult({ checked: true })).toEqual({ checked: true });
    expect(probe.parseProbeResult('prefix {"visible":true} suffix')).toEqual({ visible: true });
  });
});
