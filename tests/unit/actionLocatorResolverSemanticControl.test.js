import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const resolver = require('../../server/services/actionLocatorResolver');

describe('actionLocatorResolver semantic controls', () => {
  it('retains visible portal options that appear after the general DOM evidence cap', () => {
    const unrelatedControls = Array.from({ length: 170 }, (_, index) => (
      `<button type="button">Unrelated ${index + 1}</button>`
    )).join('');
    const dom = new JSDOM([
      '<!doctype html><html><body>',
      unrelatedControls,
      '<div role="listbox" aria-label="Ship Direction options">',
      '<div role="option">Outbound</div>',
      '<div role="option">Inbound</div>',
      '</div>',
      '</body></html>',
    ].join(''), { pretendToBeVisual: true, runScripts: 'outside-only' });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return { left: 0, top: 0, right: 100, bottom: 24, width: 100, height: 24 };
      },
    });
    dom.window.document.elementFromPoint = () => null;

    const collectEvidence = dom.window.eval(resolver.SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION);
    const evidence = collectEvidence();

    expect(evidence.candidates.some((candidate) => (
      candidate.role === 'option' && candidate.accessibleName === 'Inbound'
    ))).toBe(true);
    dom.window.close();
  });

  it('resolves a checked radio whose visible label is the following sibling', () => {
    const snapshotText = [
      '- generic:',
      '  - radio [checked] [ref=ship-date-radio]',
      '  - generic [ref=ship-date-label]: Ship Date & Time',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Ship Date & Time',
      roleHints: ['radio', 'menuitemradio'],
    })).toMatchObject({
      ok: true,
      ref: 'ship-date-radio',
      phaseAlreadySatisfied: true,
    });
  });

  it('retains a late in-viewport expanded disclosure owner in DOM evidence', () => {
    const unrelatedControls = Array.from({ length: 170 }, (_, index) => (
      `<button type="button">Unrelated ${index + 1}</button>`
    )).join('');
    const dom = new JSDOM([
      '<!doctype html><html><body>', unrelatedControls,
      '<section class="disclosure disclosure--expanded"><button>Pickup and Delivery</button></section>',
      '</body></html>',
    ].join(''), { pretendToBeVisual: true, runScripts: 'outside-only' });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() { return { left: 0, top: 0, right: 100, bottom: 24, width: 100, height: 24 }; },
    });
    dom.window.document.elementFromPoint = () => null;

    const evidence = dom.window.eval(resolver.SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION)();
    expect(evidence.candidates.some((candidate) => (
      candidate.role === 'button'
      && candidate.accessibleName === 'Pickup and Delivery'
      && candidate.semanticExpanded === true
    ))).toBe(true);
    dom.window.close();
  });

  it('captures open-shadow controls with their shadow and injected frame context', () => {
    const dom = new JSDOM('<!doctype html><html><body><div data-qaai-id="shipping-widget"></div></body></html>', {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() { return { left: 0, top: 0, right: 100, bottom: 24, width: 100, height: 24 }; },
    });
    dom.window.document.elementFromPoint = () => null;
    dom.window.__QAAI_FRAME_CONTEXT__ = {
      frameId: 'orders-frame',
      framePath: ['iframe#orders'],
    };
    const host = dom.window.document.querySelector('[data-qaai-id="shipping-widget"]');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button aria-label="Equipment">Open</button>';

    const evidence = dom.window.eval(resolver.SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION)();
    const candidate = evidence.candidates.find((item) => item.accessibleName === 'Equipment');

    expect(evidence.context).toEqual({ frameId: 'orders-frame', framePath: ['iframe#orders'] });
    expect(candidate).toMatchObject({
      role: 'button',
      frameId: 'orders-frame',
      framePath: ['iframe#orders'],
      shadowPath: ['div[data-qaai-id="shipping-widget"]'],
      actionOwnerIsSelf: true,
    });
    dom.window.close();
  });

  it.each([
    ['Equipment dropdown', 'combobox', 'equipment-ref', ['combobox', 'button']],
    ['Pickup Date calendar', 'button', 'date-ref', ['textbox', 'combobox', 'button']],
    ['Pickup Time dropdown', 'button', 'time-ref', ['combobox', 'button', 'textbox']],
    ['Pickup and Delivery section', 'button', 'disclosure-ref', ['button', 'treeitem']],
    ['Ship Date & Time', 'radio', 'radio-ref', ['radio', 'menuitemradio']],
  ])('resolves an unnamed %s control from bounded structural label evidence', (label, role, ref, roleHints) => {
    const structuralLabel = label
      .replace(/\s+(?:dropdown|calendar|section)$/i, '')
      .trim();
    const snapshotText = [
      '- group "Appointment controls":',
      `  - text "${structuralLabel}"`,
      `  - ${role} [ref=${ref}]`,
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label,
      roleHints,
      semanticTarget: { kind: 'control_opener' },
    })).toMatchObject({
      ok: true,
      ref,
      candidateCount: 1,
    });
  });

  it('uses a formal DOM label association to bind an unnamed snapshot control by stable id', () => {
    const snapshotText = '- combobox [ref=equipment-ref] [id="equipment-control"]';
    const domEvidence = {
      roleCounts: { combobox: 1 },
      candidates: [{
        role: 'combobox',
        roleOrdinal: 0,
        id: 'equipment-control',
        associatedLabels: ['Equipment'],
        accessibleName: '',
        visible: true,
        enabled: true,
      }],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Equipment dropdown',
      roleHints: ['combobox', 'button'],
      semanticTarget: { kind: 'control_opener' },
      domEvidence,
    })).toMatchObject({
      ok: true,
      ref: 'equipment-ref',
      fulfilledBy: 'snapshot_dom_semantic_control',
    });
  });

  it('keeps a choice owner separate from its unique adjacent interaction trigger', () => {
    const snapshotText = [
      '- group "Shipping controls":',
      '  - combobox "Equipment" [ref=equipment-owner]',
      '  - button [ref=equipment-trigger]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Equipment',
      roleHints: ['combobox', 'button'],
      semanticTarget: { kind: 'control_opener', controlKind: 'choice' },
    })).toMatchObject({
      ok: true,
      ref: 'equipment-owner',
      resolvedCandidate: {
        resolvedControl: {
          ownerNode: { ref: 'equipment-owner', role: 'combobox' },
          interactionNode: { ref: 'equipment-trigger', role: 'button' },
          valueNode: { ref: 'equipment-owner', role: 'combobox' },
          popupNode: null,
        },
      },
    });
  });

  it('rejects an owner with multiple indistinguishable adjacent triggers', () => {
    const snapshotText = [
      '- group "Shipping controls":',
      '  - combobox "Equipment" [ref=equipment-owner]',
      '  - button [ref=trigger-a]',
      '  - button [ref=trigger-b]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Equipment',
      roleHints: ['combobox', 'button'],
      semanticTarget: { kind: 'control_opener', controlKind: 'choice' },
    })).toMatchObject({
      ok: false,
      code: 'ambiguous_semantic_control',
      ambiguous: true,
    });
  });

  it('selects an exact option only inside its opened owner scope', () => {
    const snapshotText = [
      '- group "Shipping Method":',
      '  - listbox "Shipping Method options" [ref=other-list]:',
      '    - option "LTL" [ref=outside-option]',
      '- group "Equipment":',
      '  - combobox "Equipment" [expanded] [ref=equipment-control]',
      '  - listbox "Equipment options" [ref=equipment-list]:',
      '    - option "LTL" [ref=inside-option]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'LTL',
      roleHints: ['option', 'menuitemradio', 'treeitem'],
      ownerScope: { ownerTarget: 'Equipment', openedByPhase: 'open-choice-control' },
      semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
    })).toMatchObject({ ok: true, ref: 'inside-option' });
  });

  it('selects a unique detached overlay option when its owner is expanded', () => {
    const snapshotText = [
      '- combobox "Equipment" [expanded] [ref=equipment-control]',
      '- listbox [ref=detached-overlay]:',
      '  - option "LTL" [ref=detached-option]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'LTL',
      roleHints: ['option'],
      ownerScope: { ownerTarget: 'Equipment', openedByPhase: 'open-choice-control' },
      semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
    })).toMatchObject({ ok: true, ref: 'detached-option' });
  });

  it('matches equivalent 12-hour and 24-hour time option labels exactly', () => {
    const snapshotText = [
      '- combobox "Early Pickup Time" [expanded] [ref=time-control]',
      '- listbox "Early Pickup Time options" [ref=time-list]:',
      '  - option "08:30" [ref=time-0830]',
      '  - option "09:00" [ref=time-0900]',
      '  - option "09:30" [ref=time-0930]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: '09:00 AM',
      roleHints: ['option'],
      ownerScope: { ownerTarget: 'Early Pickup Time', openedByPhase: 'open-choice-control' },
      ownerInteractionConfirmed: true,
      semanticTarget: { kind: 'option', name: '09:00 AM', match: 'exact' },
    })).toMatchObject({ ok: true, ref: 'time-0900' });
  });

  it('selects a unique option that appeared only after opening its owner', () => {
    const before = '- combobox "Equipment" [ref=equipment-control]';
    const after = [
      before,
      '- listbox [ref=detached-overlay]:',
      '  - option "LTL" [ref=detached-option]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(after, {
      label: 'LTL',
      roleHints: ['option'],
      ownerScope: { ownerTarget: 'Equipment', openedByPhase: 'open-choice-control' },
      semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
      snapshotBefore: before,
    })).toMatchObject({ ok: true, ref: 'detached-option' });
  });

  it.each(['listitem', 'generic'])(
    'accepts an exact visible detached %s row only after the owner interaction completed',
    (role) => {
      const snapshotText = [
        '- combobox "Equipment" [ref=equipment-control]',
        `- ${role} "LTL" [ref=detached-row]`,
      ].join('\n');
      const contract = {
        label: 'LTL',
        roleHints: ['option'],
        ownerScope: { ownerTarget: 'Equipment', openedByPhase: 'open-choice-control' },
        semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
      };

      expect(resolver.resolveSemanticActionTarget(snapshotText, contract))
        .toMatchObject({ ok: false, code: 'no_compatible_semantic_control' });
      expect(resolver.resolveSemanticActionTarget(snapshotText, {
        ...contract,
        ownerInteractionConfirmed: true,
      })).toMatchObject({ ok: true, ref: 'detached-row' });
    },
  );

  it('deduplicates snapshot aliases that DOM evidence maps to one backend identity', () => {
    const snapshotText = [
      '- listitem "LTL" [ref=option-alias-a]',
      '- listitem "LTL" [ref=option-alias-b]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { listitem: 2 },
      candidates: [
        { role: 'listitem', roleOrdinal: 0, accessibleName: 'LTL', backendNodeId: 73, visible: true, enabled: true },
        { role: 'listitem', roleOrdinal: 1, accessibleName: 'LTL', backendNodeId: 73, visible: true, enabled: true },
      ],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'LTL',
      roleHints: ['option'],
      ownerScope: { ownerTarget: 'Equipment', openedByPhase: 'open-choice-control' },
      ownerInteractionConfirmed: true,
      semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
      domEvidence,
    })).toMatchObject({ ok: true, candidateCount: 1 });
  });

  it('keeps duplicate exact options inside one owner ambiguous', () => {
    const snapshotText = [
      '- group "Equipment":',
      '  - combobox "Equipment" [expanded] [ref=equipment-control]',
      '  - listbox "Equipment options" [ref=equipment-list]:',
      '    - option "LTL" [ref=option-a]',
      '    - option "LTL" [ref=option-b]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'LTL',
      roleHints: ['option'],
      ownerScope: { ownerTarget: 'Equipment' },
      ownerInteractionConfirmed: true,
      semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
    })).toMatchObject({
      ok: false,
      ambiguous: true,
      code: 'ambiguous_semantic_control',
      candidateCount: 2,
    });
  });

  it('marks an expanded owner phase satisfied without treating its option as the opener', () => {
    const snapshotText = [
      '- group "Equipment":',
      '  - combobox "Equipment" [expanded] [ref=equipment-control]',
      '  - listbox "Equipment options" [ref=equipment-list]:',
      '    - option "LTL" [ref=option-ref]',
    ].join('\n');

    const opener = resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Equipment',
      roleHints: ['combobox', 'button'],
      semanticTarget: { kind: 'control_opener' },
    });
    const option = resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'LTL',
      roleHints: ['option'],
      ownerScope: { ownerTarget: 'Equipment' },
      semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
    });

    expect(opener).toMatchObject({ ok: true, ref: 'equipment-control', phaseAlreadySatisfied: true });
    expect(option).toMatchObject({ ok: true, ref: 'option-ref', phaseAlreadySatisfied: false });
  });

  it('pairs a structurally owned dropdown trigger with its display/value combobox', () => {
    const snapshotText = [
      '- generic:',
      '  - generic: Ship Direction *',
      '  - generic:',
      '    - combobox "Ship Direction *" [ref=direction-display]: Select',
      '    - button "dropdown trigger" [ref=direction-trigger]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Ship Direction',
      roleHints: ['button', 'combobox'],
      semanticTarget: { kind: 'control_opener', controlKind: 'choice', ownerTarget: 'Ship Direction' },
    })).toMatchObject({
      ok: true,
      ref: 'direction-display',
      resolvedCandidate: {
        resolvedControl: {
          ownerNode: { ref: 'direction-display' },
          interactionNode: { ref: 'direction-trigger' },
          valueNode: { ref: 'direction-display' },
        },
      },
    });
  });

  it('prefers the disclosure-capable header over child controls in the same section', () => {
    const snapshotText = [
      '- group "Pickup and Delivery":',
      '  - button "Expand" [aria-expanded=false] [ref=section-header]',
      '  - button "Early Pickup Date" [ref=date-button]',
      '  - button "Early Pickup Time" [ref=time-button]',
      '  - button "Late Pickup Date" [ref=late-date-button]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Pickup and Delivery section',
      roleHints: ['button', 'treeitem'],
      semanticTarget: { kind: 'control_opener', controlKind: 'disclosure' },
    })).toMatchObject({ ok: true, ref: 'section-header', candidateCount: 1 });
  });

  it('does not degrade a disclosure request to a generic child control', () => {
    const snapshotText = [
      '- group "Pickup and Delivery":',
      '  - button "Early Pickup Date" [ref=date-button]',
      '  - combobox "Early Pickup Time" [ref=time-combobox]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Pickup and Delivery section',
      roleHints: ['button', 'combobox', 'treeitem'],
      semanticTarget: { kind: 'control_opener', controlKind: 'disclosure' },
    })).toMatchObject({
      ok: false,
      code: 'no_compatible_semantic_control',
      candidateCount: 0,
    });
  });

  it('prefers an ARIA disclosure owner over expanded descendant choice controls', () => {
    const snapshotText = [
      '- group "Pickup and Delivery":',
      '  - button "Expand" [aria-expanded=false] [ref=section-header]',
      '  - combobox "Early Pickup Time" [aria-expanded=false] [ref=time-combobox]',
      '  - combobox "Late Pickup Time" [aria-expanded=false] [ref=late-time-combobox]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Pickup and Delivery section',
      roleHints: ['button', 'combobox', 'treeitem'],
      semanticTarget: { kind: 'control_opener', controlKind: 'disclosure' },
    })).toMatchObject({ ok: true, ref: 'section-header', candidateCount: 1 });
  });

  it('accepts an exact ARIA-expanded generic node as the disclosure owner', () => {
    const snapshotText = '- generic "Pickup and Delivery" [aria-expanded=false] [ref=section-owner]';

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Pickup and Delivery section',
      roleHints: ['button', 'combobox', 'treeitem'],
      semanticTarget: { kind: 'control_opener', controlKind: 'disclosure' },
    })).toMatchObject({ ok: true, ref: 'section-owner', candidateCount: 1 });
  });

  it('binds radio controls to an adjacent exact static label instead of the enclosing group', () => {
    const snapshotText = [
      '- group "Planning Date and Time":',
      '  - text "Ship Date & Time" [ref=ship-label]',
      '  - radio [ref=ship-radio]',
      '  - text "Delivery Date & Time" [ref=delivery-label]',
      '  - radio [ref=delivery-radio]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Ship Date & Time option',
      roleHints: ['radio', 'menuitemradio'],
    })).toMatchObject({ ok: true, ref: 'ship-radio', candidateCount: 1 });
  });

  it.each([
    ['Early Pickup Date calendar', 'early-date', 'late-date', 'Early Pickup Date', 'Late Pickup Date'],
    ['Early Pickup Time dropdown', 'early-time', 'late-time', 'Early Pickup Time', 'Late Pickup Time'],
  ])('binds %s to its adjacent exact label among similar controls', (label, expectedRef, otherRef, expectedLabel, otherLabel) => {
    const snapshotText = [
      '- group "Planning Date and Time":',
      `  - text "${expectedLabel}" [ref=${expectedRef}-label]`,
      `  - textbox [ref=${expectedRef}]`,
      `  - text "${otherLabel}" [ref=${otherRef}-label]`,
      `  - textbox [ref=${otherRef}]`,
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label,
      roleHints: ['textbox', 'combobox', 'button'],
    })).toMatchObject({ ok: true, ref: expectedRef, candidateCount: 1 });
  });

  it('binds an MCP colon-form static label to its adjacent editable control', () => {
    const snapshotText = [
      '- group "Order identifiers":',
      '  - text: Order Number',
      '  - textbox "Enter an ID" [ref=order-id]',
      '  - textbox "Enter a Pickup Number" [ref=pickup-number]',
      '  - textbox "Enter a PO Number" [ref=po-number]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Order Number field',
      roleHints: ['textbox'],
    })).toMatchObject({
      ok: true,
      ref: 'order-id',
      code: 'semantic_control_resolved',
      candidateCount: 1,
    });
  });

  it('prefers the exact associated date input and preserves duplicate ambiguity', () => {
    const snapshotText = [
      '- textbox [ref=date-a]',
      '- textbox [ref=date-b]',
    ].join('\n');
    const evidenceFor = (secondLabel) => ({
      roleCounts: { textbox: 2 },
      candidates: [
        {
          role: 'textbox', roleOrdinal: 0, associatedLabels: ['Early Pickup Date'],
          inputType: 'date', snapshotRef: 'date-a', visible: true, enabled: true,
        },
        {
          role: 'textbox', roleOrdinal: 1, associatedLabels: [secondLabel],
          inputType: 'date', snapshotRef: 'date-b', visible: true, enabled: true,
        },
      ],
    });
    const contract = {
      label: 'Early Pickup Date calendar',
      roleHints: ['textbox', 'combobox', 'button'],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      ...contract,
      domEvidence: evidenceFor('Late Pickup Date'),
    })).toMatchObject({ ok: true, ref: 'date-a', candidateCount: 1 });

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      ...contract,
      domEvidence: evidenceFor('Early Pickup Date'),
    })).toMatchObject({
      ok: false,
      code: 'ambiguous_semantic_control',
      candidateCount: 2,
    });
  });

  it('prefers the exact associated time input among equivalent textbox snapshot rows', () => {
    const snapshotText = [
      '- textbox [ref=time-a]',
      '- textbox [ref=time-b]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { textbox: 2 },
      candidates: [
        {
          role: 'textbox', roleOrdinal: 0, associatedLabels: ['Early Pickup Time'],
          inputType: 'time', snapshotRef: 'time-a', visible: true, enabled: true,
        },
        {
          role: 'textbox', roleOrdinal: 1, associatedLabels: ['Late Pickup Time'],
          inputType: 'time', snapshotRef: 'time-b', visible: true, enabled: true,
        },
      ],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Early Pickup Time dropdown',
      roleHints: ['textbox', 'combobox', 'button'],
      domEvidence,
    })).toMatchObject({ ok: true, ref: 'time-a', candidateCount: 1 });
  });

  it.each([
    ['Early Pickup Time dropdown', 'early-pickup-time'],
    ['Late Pickup Time dropdown', 'late-pickup-time'],
    ['Early Delivery Time dropdown', 'early-delivery-time'],
    ['Late Delivery Time Zone dropdown', 'late-delivery-timezone'],
  ])('uses the bounded owner label to resolve repeated temporal controls for %s', (label, expectedRef) => {
    const controls = [
      ['early-pickup-time', 'Select Time', ['Time', 'Early Pickup Date and Time']],
      ['early-pickup-timezone', 'Select Time Zone', ['Time Zone', 'Early Pickup Date and Time']],
      ['late-pickup-time', 'Select Time', ['Time', 'Late Pickup Date and Time']],
      ['late-pickup-timezone', 'Select Time Zone', ['Time Zone', 'Late Pickup Date and Time']],
      ['early-delivery-time', 'Select Time', ['Time', 'Early Delivery Date and Time']],
      ['early-delivery-timezone', 'Select Time Zone', ['Time Zone', 'Early Delivery Date and Time']],
      ['late-delivery-time', 'Select Time', ['Time', 'Late Delivery Date and Time']],
      ['late-delivery-timezone', 'Select Time Zone', ['Time Zone', 'Late Delivery Date and Time']],
    ];
    const snapshotText = controls.map(([ref, name]) => `- combobox "${name}" [ref=${ref}]`).join('\n');
    const domEvidence = {
      roleCounts: { combobox: controls.length },
      candidates: controls.map(([ref, name, scopedLabels], roleOrdinal) => ({
        role: 'combobox',
        roleOrdinal,
        accessibleName: name,
        snapshotRef: ref,
        scopedLabels,
        visible: true,
        enabled: true,
      })),
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label,
      roleHints: ['combobox', 'button', 'textbox'],
      domEvidence,
    })).toMatchObject({ ok: true, ref: expectedRef, candidateCount: 1 });
  });

  it('refuses repeated time controls when bounded owner evidence is genuinely absent', () => {
    const snapshotText = [
      '- combobox "Select Time" [ref=time-a]',
      '- combobox "Select Time" [ref=time-b]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { combobox: 2 },
      candidates: [
        { role: 'combobox', roleOrdinal: 0, accessibleName: 'Select Time', snapshotRef: 'time-a', visible: true, enabled: true },
        { role: 'combobox', roleOrdinal: 1, accessibleName: 'Select Time', snapshotRef: 'time-b', visible: true, enabled: true },
      ],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Early Pickup Time dropdown',
      roleHints: ['combobox', 'button', 'textbox'],
      domEvidence,
    })).toMatchObject({ ok: false, code: 'no_compatible_semantic_control' });
  });

  it('keeps duplicate editable controls ambiguous when hit testing has no node identity binding', () => {
    const snapshotText = [
      '- text "Primary Order Number"',
      '- textbox [ref=order-a]',
      '- text "Backup Order Number"',
      '- textbox [ref=order-b]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { textbox: 2 },
      candidates: [
        { role: 'textbox', roleOrdinal: 0, accessibleName: 'Order Number', visible: true, enabled: true, inViewport: true, hitTarget: false },
        { role: 'textbox', roleOrdinal: 1, accessibleName: 'Order Number', visible: true, enabled: true, inViewport: true, hitTarget: true },
      ],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Order Number field',
      roleHints: ['textbox'],
      domEvidence,
    })).toMatchObject({
      ok: false,
      code: 'ambiguous_semantic_control',
      ambiguous: true,
    });
  });

  it('uses an explicit accessibility-ref binding instead of role order for duplicate controls', () => {
    const snapshotText = [
      '- text "Primary Order Number"',
      '- textbox [ref=order-a]',
      '- text "Backup Order Number"',
      '- textbox [ref=order-b]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { textbox: 2 },
      candidates: [
        { role: 'textbox', roleOrdinal: 0, snapshotRef: 'order-b', visible: true, enabled: true },
        { role: 'textbox', roleOrdinal: 1, snapshotRef: 'order-a', visible: true, enabled: true },
      ],
    };

    const boundResolution = resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Primary Order Number field',
      roleHints: ['textbox'],
      domEvidence,
    });
    expect(boundResolution).toMatchObject({
      ok: true,
      ref: 'order-a',
      resolvedCandidate: {
        resolvedControl: { ownerNode: { ref: 'order-a' } },
      },
    });
  });

  it('rejects a Pickup Number textbox even when a nearby snapshot label says Early Pickup Date', () => {
    const snapshotText = [
      '- group "Planning Date and Time":',
      '  - text: Early Pickup Date',
      '  - textbox "Enter a Pickup Number" [ref=pickup-number]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { textbox: 1 },
      candidates: [{
        role: 'textbox',
        roleOrdinal: 0,
        accessibleName: 'Enter a Pickup Number',
        placeholder: 'Enter a Pickup Number',
        inputType: 'text',
        visible: true,
        enabled: true,
      }],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Early Pickup Date calendar',
      roleHints: ['textbox', 'combobox', 'button'],
      domEvidence,
    })).toMatchObject({
      ok: false,
      code: 'no_compatible_semantic_control',
      candidateCount: 0,
    });
  });

  it('promotes an inner icon candidate to its semantic actionable owner', () => {
    const snapshotText = [
      '- button [ref=equipment-owner] [id="equipment-owner-id"]:',
      '  - generic "Equipment" [ref=equipment-icon]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { button: 1, generic: 1 },
      candidates: [{
        role: 'generic',
        roleOrdinal: 0,
        accessibleName: 'Equipment',
        visible: true,
        enabled: true,
        actionOwnerIsSelf: false,
        actionOwnerRole: 'button',
        actionOwnerRoleOrdinal: 0,
        actionOwnerId: 'equipment-owner-id',
        actionOwnerAccessibleName: 'Equipment',
        actionOwnerAssociatedLabels: ['Equipment'],
      }],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Equipment dropdown',
      roleHints: ['button', 'generic'],
      semanticTarget: { kind: 'control_opener', controlKind: 'choice' },
      domEvidence,
    })).toMatchObject({
      ok: true,
      ref: 'equipment-owner',
      resolvedCandidate: { ownerPromoted: true },
    });
  });

  it.each([
    ['framePath', ['iframe#orders'], ['iframe#archive']],
    ['shadowPath', ['qaai-order-form'], ['legacy-order-form']],
  ])('resolves duplicate labels only inside the requested %s', (pathKey, wantedPath, otherPath) => {
    const snapshotText = [
      '- textbox "Order Number" [ref=other-context] [id="other-order"]',
      '- textbox "Order Number" [ref=wanted-context] [id="wanted-order"]',
    ].join('\n');
    const candidates = [
      {
        role: 'textbox', roleOrdinal: 0, accessibleName: 'Order Number',
        id: 'other-order', visible: true, enabled: true, [pathKey]: otherPath,
      },
      {
        role: 'textbox', roleOrdinal: 1, accessibleName: 'Order Number',
        id: 'wanted-order', visible: true, enabled: true, [pathKey]: wantedPath,
      },
    ];

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Order Number field',
      roleHints: ['textbox'],
      [pathKey]: wantedPath,
      domEvidence: { roleCounts: { textbox: 2 }, candidates },
    })).toMatchObject({
      ok: true,
      ref: 'wanted-context',
      resolvedCandidate: { [pathKey]: wantedPath },
    });
  });

  it('correlates reversed duplicate DOM evidence by backend node identity, never role ordinal', () => {
    const snapshotText = [
      '- text "Early Pickup Date"',
      '- textbox [ref=early-date] [backendNodeId=101]',
      '- text "Late Pickup Date"',
      '- textbox [ref=late-date] [backendNodeId=202]',
    ].join('\n');
    const domEvidence = {
      roleCounts: { textbox: 2 },
      candidates: [
        { role: 'textbox', roleOrdinal: 0, backendNodeId: 202, inputType: 'date', visible: true, enabled: true },
        { role: 'textbox', roleOrdinal: 1, backendNodeId: 101, inputType: 'date', visible: true, enabled: true },
      ],
    };

    expect(resolver.resolveSemanticActionTarget(snapshotText, {
      label: 'Early Pickup Date',
      roleHints: ['textbox'],
      domEvidence,
    })).toMatchObject({
      ok: true,
      ref: 'early-date',
      resolvedCandidate: {
        resolvedControl: {
          ownerNode: { ref: 'early-date', backendNodeId: 101 },
        },
      },
    });
  });

  it('recovers a stale ref from fresh semantic evidence before dispatch only', () => {
    const snapshotText = '- combobox "Equipment" [ref=equipment-new]';
    const targetContract = {
      label: 'Equipment dropdown',
      roleHints: ['combobox', 'button'],
      semanticTarget: { kind: 'control_opener', controlKind: 'choice' },
    };

    expect(resolver.recoverSemanticActionTargetBeforeDispatch({
      snapshotText,
      targetContract,
      previousResolution: { ref: 'equipment-stale' },
      dispatchStatus: 'precondition_proven',
    })).toMatchObject({
      ok: true,
      ref: 'equipment-new',
      code: 'semantic_control_recovered_before_dispatch',
      staleRef: true,
      recoveredBeforeDispatch: true,
    });

    expect(resolver.recoverSemanticActionTargetBeforeDispatch({
      snapshotText,
      targetContract,
      previousResolution: { ref: 'equipment-stale' },
      dispatchStatus: 'delivered',
    })).toMatchObject({
      ok: false,
      ref: null,
      code: 'stale_ref_recovery_forbidden_after_dispatch',
      staleRef: true,
    });
  });
});
