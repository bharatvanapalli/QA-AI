import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const resolver = require('../../server/services/actionLocatorResolver.js');

async function captureStructuralLocatorFromDom(html, targetSelector, options = {}) {
  const dom = new JSDOM(html);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const target = dom.window.document.querySelector(targetSelector);
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
    return await resolver.captureStructuralLocator({
      session,
      ref: options.ref || 'e42',
      element: options.element || targetSelector,
      pageUrl: options.pageUrl || 'https://example.test/phase-3',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

describe('Phase 3 fill_form locator completeness', () => {
  it('keeps every requested fill_form field in the multi-locator proof and fails when one field lacks locator evidence', async () => {
    const snapshotText = [
      '- textbox "Email Address" [ref=e1]',
    ].join('\n');

    const actionLocator = await resolver.resolveForTool({
      session: {},
      toolName: 'browser_fill_form',
      snapshotText,
      pageUrl: 'https://example.test/login',
      args: {
        fields: [
          { element: 'Email Address', ref: 'e1', value: 'user@example.test' },
          { element: 'Password', value: 'secret-password' },
        ],
      },
      elementLabel: 'login form',
    });

    expect(actionLocator?.kind).toBe('multi');
    expect(actionLocator.fields).toHaveLength(2);
    expect(actionLocator.fields[0].actionLocator).toBeTruthy();
    expect(actionLocator.fields[1]).toMatchObject({
      index: 1,
      name: 'Password',
      actionLocator: null,
      missingLocator: true,
    });
    expect(resolver.isVerifiedActionLocator(actionLocator)).toBe(false);
  });

  it('captures data-qaai-id as a first-class action-time locator', async () => {
    const actionLocator = await captureStructuralLocatorFromDom(`
      <main>
        <button id="runtime-0d430f56" class="MuiButton-root css-x9f884" data-qaai-id="save-user-primary">Save user</button>
      </main>
    `, 'button');
    const expression = actionLocator?.frameworkExpressions?.playwright || actionLocator?.expression || '';

    expect(actionLocator?.strategy).toBe('qaai-attr');
    expect(expression).toBe('locator("[data-qaai-id=\\"save-user-primary\\"]")');
    expect(expression).not.toMatch(/runtime|MuiButton|nth-(?:child|of-type)|\.(?:nth|first|last)\s*\(/);
  });

  it('ranks role and stable attributes ahead of high-scoring brittle css candidates', () => {
    const selected = resolver.chooseCandidate([
      {
        strategy: 'css-id',
        expression: 'locator("#session-9f1a1b2c")',
        proof: { count: 1, sameElement: true },
        score: 5000,
      },
      {
        strategy: 'role',
        expression: 'getByRole("button", { name: "Save user" })',
        role: 'button',
        name: 'Save user',
        proof: { count: 1, sameElement: true },
        score: 10,
      },
    ]);

    expect(selected?.strategy).toBe('role');
  });

  it('keeps weak fallback executable while exposing downgrade warnings', () => {
    const warnings = resolver.locatorCandidateWarnings({
      strategy: 'css-structural',
      expression: 'locator("main > section:nth-child(2) > button")',
      proof: { count: 1, sameElement: true },
      targetFacts: { id: 'user-9f1a1b2c-7788-49df-8db0-a224579a33ef' },
    });

    expect(warnings).toContain('structural_css');
    expect(warnings).toContain('dynamic_token');
    expect(resolver.locatorCandidateRank({
      strategy: 'role',
      expression: 'getByRole("button", { name: "Save user" })',
      proof: { count: 1, sameElement: true },
    })).toBeGreaterThan(resolver.locatorCandidateRank({
      strategy: 'css-structural',
      expression: 'locator("main > section:nth-child(2) > button")',
      proof: { count: 1, sameElement: true },
    }));
  });
});

describe('semantic repeated-control resolution', () => {
  const planningSnapshot = [
    '- generic "Pickup and Delivery" [ref=section]:',
    '  - generic [ref=section-shell]:',
    '    - button "Pickup and Delivery Shipper, Consignee, and Planning Dates" [ref=section-trigger] [cursor=pointer]',
    '    - generic [ref=section-content]:',
    '      - heading [level=2] [ref=planning-heading]: Planning Date/Time',
    '      - generic [ref=early-pickup]:',
    '        - generic [ref=early-pickup-title]: Early Pickup Date and Time',
    '        - generic [ref=early-pickup-date-field]:',
    '          - generic [ref=early-pickup-date-label]: Date',
    '          - combobox [ref=early-pickup-date]',
    '        - generic [ref=early-pickup-time-field]:',
    '          - generic [ref=early-pickup-time-label]: Time',
    '          - combobox [ref=early-pickup-time]: Select Time',
    '        - generic [ref=early-pickup-zone-field]:',
    '          - generic [ref=early-pickup-zone-label]: Time Zone',
    '          - combobox [ref=early-pickup-zone]: Select Timezone',
    '      - generic [ref=late-delivery]:',
    '        - generic [ref=late-delivery-title]: Late Delivery Date and Time',
    '        - generic [ref=late-delivery-date-field]:',
    '          - generic [ref=late-delivery-date-label]: Date',
    '          - combobox [ref=late-delivery-date]',
    '        - generic [ref=late-delivery-time-field]:',
    '          - generic [ref=late-delivery-time-label]: Time',
    '          - combobox [ref=late-delivery-time]: Select Time',
    '        - generic [ref=late-delivery-zone-field]:',
    '          - generic [ref=late-delivery-zone-label]: Time Zone',
    '          - combobox [ref=late-delivery-zone]: Select Timezone',
  ].join('\n');

  it.each([
    ['Early Pickup Date calendar', 'early-pickup-date'],
    ['Early Pickup Time dropdown', 'early-pickup-time'],
    ['Early Pickup Time Zone dropdown', 'early-pickup-zone'],
    ['Late Delivery Date calendar', 'late-delivery-date'],
    ['Late Delivery Time dropdown', 'late-delivery-time'],
    ['Late Delivery Time Zone dropdown', 'late-delivery-zone'],
  ])('scopes %s to its local labelled control', (label, ref) => {
    expect(resolver.resolveSemanticActionTarget(planningSnapshot, {
      label,
      roleHints: ['textbox', 'combobox', 'listbox', 'button'],
    })).toMatchObject({ ok: true, ref });
  });

  it('uses structural owner context when a neighboring temporal label is closer in tree order', () => {
    const snapshot = [
      '- generic "Planning Date and Time" [ref=planning]:',
      '  - radio "Ship Date & Time" [checked] [ref=ship-mode]',
      '  - generic "Late Pickup Date and Time" [ref=neighboring-group]',
      '  - generic "Early Pickup Date and Time" [ref=early-pickup]:',
      '    - generic [ref=early-date-field]:',
      '      - generic [ref=early-date-label]: Date',
      '      - textbox "Date" [ref=early-date]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Early Pickup Date',
      roleHints: ['textbox', 'combobox', 'button'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'date',
        ownerTarget: 'Early Pickup Date',
      },
    })).toMatchObject({ ok: true, ref: 'early-date' });
  });

  it('resolves a uniquely compatible field when provider context is absent from its accessible name', () => {
    const snapshot = [
      '- textbox [ref=identifier]: user@example.test',
      '- heading "Enter password" [level=1]',
      '- textbox "Enter the password for user@example.test" [active] [ref=secret]',
      '- button "Sign in" [ref=submit]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Identity provider password field',
      roleHints: ['textbox'],
    })).toMatchObject({ ok: true, ref: 'secret' });
  });

  it('does not broaden a fill combobox hint into an unrelated button target', () => {
    const snapshot = [
      '- textbox "Enter your email, phone, or Skype." [active] [ref=identifier]',
      '- button "Next" [ref=submit]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Microsoft email, phone, or Skype field',
      roleHints: ['textbox', 'searchbox', 'spinbutton', 'combobox'],
      semanticTarget: {
        kind: 'field',
        controlKind: 'text',
      },
    })).toMatchObject({
      ok: true,
      ref: 'identifier',
      resolvedCandidate: { role: 'textbox' },
    });
  });

  it('does not treat accessibility-tree body content alone as an already-open section', () => {
    expect(resolver.resolveSemanticActionTarget(planningSnapshot, {
      label: 'Pickup and Delivery section',
      roleHints: ['button', 'combobox', 'treeitem'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'disclosure',
        ownerTarget: 'Pickup and Delivery section',
      },
    })).toMatchObject({
      ok: true,
      ref: 'section-trigger',
      phaseAlreadySatisfied: false,
    });
  });

  it('treats an explicitly expanded disclosure as already open', () => {
    const snapshot = [
      '- button "Pickup and Delivery Shipper, Consignee, and Planning Dates" [ref=section-trigger] [expanded]',
      '- generic [ref=section-content]:',
      '  - heading [level=2] [ref=planning-heading]: Planning Date/Time',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Pickup and Delivery section',
      roleHints: ['button', 'combobox', 'treeitem'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'disclosure',
        ownerTarget: 'Pickup and Delivery section',
      },
    })).toMatchObject({
      ok: true,
      ref: 'section-trigger',
      phaseAlreadySatisfied: true,
    });
  });

  it('does not treat visible neighboring content as proof when the disclosure is explicitly collapsed', () => {
    const snapshot = [
      '- button "Pickup and Delivery Shipper, Consignee, and Planning Dates" [ref=section-trigger] [expanded=false]',
      '- generic [ref=neighboring-content]:',
      '  - heading [level=2] [ref=planning-heading]: Planning Date/Time',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Pickup and Delivery section',
      roleHints: ['button', 'combobox', 'treeitem'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'disclosure',
        ownerTarget: 'Pickup and Delivery section',
      },
    })).toMatchObject({
      ok: true,
      ref: 'section-trigger',
      phaseAlreadySatisfied: false,
    });
  });

  it('resolves an unnamed adjacent dropdown trigger from its labelled combobox owner', () => {
    const snapshot = [
      '- generic [ref=field]:',
      '  - generic [ref=label]: Equipment *',
      '  - generic [ref=control]:',
      '    - combobox "Equipment *" [active] [ref=equipment-input]',
      '    - button [ref=equipment-trigger]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Equipment',
      roleHints: ['button'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'choice',
        ownerTarget: 'Equipment',
        preferTrigger: true,
      },
    })).toMatchObject({
      ok: true,
      ref: 'equipment-input',
      resolvedCandidate: {
        role: 'combobox',
        resolvedControl: {
          ownerNode: { ref: 'equipment-input' },
          interactionNode: { ref: 'equipment-trigger' },
        },
      },
    });
  });

  it('uses the labelled accessibility owner when generic DOM triggers are ambiguous', () => {
    const snapshot = [
      '- generic "General Information Order identifiers organization equipment references and additional explanatory content that exceeds the token budget" [ref=form]:',
      '  - generic [ref=controls]:',
      '    - generic [ref=direction-control]:',
      '      - combobox "Ship Direction *" [ref=direction-input]: Inbound',
      '      - button "dropdown trigger" [ref=direction-trigger]',
      '    - generic [ref=term-control]:',
      '      - combobox "Freight Term *" [ref=term-input]: COL',
      '      - button "dropdown trigger" [ref=term-trigger]',
    ].join('\n');
    const genericTrigger = {
      role: 'button',
      accessibleName: 'dropdown trigger',
      visible: true,
      enabled: true,
      hitTarget: true,
      inViewport: true,
      actionOwnerIsSelf: true,
      actionOwnerRole: 'button',
    };

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Freight Term',
      roleHints: ['button'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'choice',
        ownerTarget: 'Freight Term',
        preferTrigger: true,
      },
      domEvidence: {
        candidates: [
          { ...genericTrigger, roleOrdinal: 0, actionOwnerRoleOrdinal: 0 },
          { ...genericTrigger, roleOrdinal: 1, actionOwnerRoleOrdinal: 1 },
        ],
        // Deliberately prevent ordinal parity so DOM evidence is ambiguous.
        roleCounts: { button: 3 },
      },
    })).toMatchObject({
      ok: true,
      ref: 'term-input',
      candidateCount: 1,
      resolvedCandidate: {
        resolvedControl: {
          ownerNode: { ref: 'term-input' },
          interactionNode: { ref: 'term-trigger' },
        },
      },
    });
  });

  it('resolves an unnamed typed radio from its exact adjacent label despite DOM wrapper ambiguity', () => {
    const snapshot = [
      '- generic "Planning Date and Time" [ref=planning]:',
      '  - generic [ref=ship-wrapper] [cursor=pointer]:',
      '    - radio [checked] [ref=ship-radio]',
      '    - generic [ref=ship-label]: Ship Date & Time',
      '  - generic [ref=delivery-wrapper] [cursor=pointer]:',
      '    - radio [ref=delivery-radio]',
      '    - generic [ref=delivery-label]: Delivery Date & Time',
    ].join('\n');
    const ambiguousRadio = {
      role: 'radio',
      accessibleName: 'Ship Date & Time',
      associatedLabels: ['Ship Date & Time'],
      visible: true,
      enabled: true,
      hitTarget: true,
      inViewport: true,
      actionOwnerIsSelf: true,
      actionOwnerRole: 'radio',
    };

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Ship Date & Time',
      roleHints: ['radio'],
      semanticTarget: { kind: 'field', controlKind: 'radio' },
      domEvidence: {
        candidates: [
          { ...ambiguousRadio, roleOrdinal: 0, actionOwnerRoleOrdinal: 0 },
          { ...ambiguousRadio, roleOrdinal: 1, actionOwnerRoleOrdinal: 1 },
        ],
        roleCounts: { radio: 3 },
      },
    })).toMatchObject({
      ok: true,
      ref: 'ship-radio',
      candidateCount: 1,
    });
  });

  it('collapses tied DOM evidence that belongs to the same actionable owner', () => {
    const snapshot = '- button "Freight Term" [ref=freight-trigger]';
    const shared = {
      role: 'button',
      accessibleName: 'Freight Term',
      visible: true,
      enabled: true,
      actionOwnerRole: 'button',
      actionOwnerRoleOrdinal: 0,
      actionOwnerId: 'freight-term-trigger',
    };

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Freight Term',
      roleHints: ['button'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'choice',
        ownerTarget: 'Freight Term',
      },
      domEvidence: {
        candidates: [
          { ...shared, id: 'freight-term-trigger', actionOwnerIsSelf: true },
          { ...shared, id: 'freight-term-icon', actionOwnerIsSelf: false },
        ],
        roleCounts: { button: 2 },
      },
    })).toMatchObject({
      ok: true,
      ref: 'freight-trigger',
      candidateCount: 1,
    });
  });

  it('keeps equal DOM evidence from different actionable owners ambiguous', () => {
    const snapshot = '- button "Freight Term" [ref=freight-trigger]';
    const result = resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Freight Term',
      roleHints: ['button'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'choice',
        ownerTarget: 'Freight Term',
      },
      domEvidence: {
        candidates: [
          {
            role: 'button', accessibleName: 'Freight Term', visible: true, enabled: true,
            actionOwnerRole: 'button', actionOwnerRoleOrdinal: 0, actionOwnerId: 'first-owner',
          },
          {
            role: 'button', accessibleName: 'Freight Term', visible: true, enabled: true,
            actionOwnerRole: 'button', actionOwnerRoleOrdinal: 1, actionOwnerId: 'second-owner',
          },
        ],
        roleCounts: { button: 2 },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      code: 'ambiguous_semantic_control',
    });
  });

  it('does not map an unrelated same-role hit target without identity evidence', () => {
    const snapshot = [
      '- generic [ref=field]:',
      '  - generic [ref=label]: Freight Term *',
      '  - combobox "Freight Term" [ref=freight-owner]',
      '  - button "Open menu" [ref=freight-trigger]',
    ].join('\n');

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Freight Term',
      roleHints: ['button'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'choice',
        ownerTarget: 'Freight Term',
        preferTrigger: true,
      },
      domEvidence: {
        candidates: [
          {
            role: 'button', accessibleName: 'Open menu', visible: true, enabled: true,
            hitTarget: true, inViewport: true, actionOwnerIsSelf: true,
            actionOwnerRole: 'button', actionOwnerRoleOrdinal: 0,
          },
          {
            role: 'button', accessibleName: 'Remove Reference row', visible: true, enabled: true,
            hitTarget: true, inViewport: true, actionOwnerIsSelf: true,
            actionOwnerRole: 'button', actionOwnerRoleOrdinal: 15,
          },
        ],
        roleCounts: { button: 16 },
      },
    })).toMatchObject({
      ok: true,
      ref: 'freight-owner',
      resolvedCandidate: {
        role: 'combobox',
        resolvedControl: {
          ownerNode: { ref: 'freight-owner' },
          interactionNode: { ref: 'freight-trigger' },
        },
      },
    });
  });

  it('does not let unrelated duplicate DOM controls create calendar ambiguity', () => {
    const snapshot = [
      '- link "Orders" [ref=orders-link]',
      '- button "dropdown trigger" [ref=unrelated-trigger]',
    ].join('\n');
    const duplicateTrigger = {
      role: 'button',
      accessibleName: 'dropdown trigger',
      visible: true,
      enabled: true,
      hitTarget: true,
      inViewport: true,
      actionOwnerRole: 'button',
    };

    expect(resolver.resolveSemanticActionTarget(snapshot, {
      label: 'Early Pickup Date calendar',
      roleHints: ['textbox', 'combobox', 'button'],
      semanticTarget: {
        kind: 'control_opener',
        controlKind: 'calendar',
        ownerTarget: 'Early Pickup Date',
      },
      domEvidence: {
        candidates: [
          { ...duplicateTrigger, actionOwnerRoleOrdinal: 0, actionOwnerId: 'first-unrelated' },
          { ...duplicateTrigger, actionOwnerRoleOrdinal: 1, actionOwnerId: 'second-unrelated' },
        ],
        roleCounts: { button: 2 },
      },
    })).toMatchObject({
      ok: false,
      code: 'no_compatible_semantic_control',
      candidateCount: 0,
    });
  });
});
