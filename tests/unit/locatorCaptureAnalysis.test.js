import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildAuthoritativeCandidateDescriptors,
  crossCheckElementSemantics,
  generateDeterministicCssCandidates,
  isGeneratedOrUnstableSelector,
} = require('../../server/services/locatorCaptureAnalysis');

describe('locator capture analysis', () => {
  it('generates bounded, unique CSS candidates for the exact acted node', () => {
    document.body.innerHTML = `
      <main>
        <button class="css-a8f93b generated-74290812" data-testid="save-profile">Save</button>
        <button>Save</button>
      </main>
    `;
    const target = document.querySelector('[data-testid="save-profile"]');
    const candidates = generateDeterministicCssCandidates(target, {
      backendNodeId: 821,
      maxResults: 5,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(candidates[0].backendNodeId).toBe(821);
    expect(candidates.every((candidate) => candidate.localDomProof.count === 1)).toBe(true);
    expect(candidates.every((candidate) => candidate.localDomProof.exactTarget)).toBe(true);
    expect(candidates.every((candidate) => candidate.requiresBackendNodeVerification)).toBe(true);
    expect(candidates.every((candidate) => candidate.backendNodeVerified === false)).toBe(true);
    expect(candidates.join(' ')).not.toMatch(/css-a8f93b|generated-74290812/);

    const withoutBackendIdentity = generateDeterministicCssCandidates(target, {
      backendNodeId: null,
      maxResults: 1,
    });
    expect(withoutBackendIdentity[0].backendNodeId).toBeNull();
  });

  it('supports scoped roots and rejects volatile attributes and generated tokens', () => {
    document.body.innerHTML = `
      <section id="first"><input name="accountEmail" /></section>
      <section id="second"><input name="accountEmail" /></section>
    `;
    const root = document.querySelector('#second');
    const target = root.querySelector('input');
    const candidates = generateDeterministicCssCandidates(target, { root, maxResults: 3 });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.localDomProof.exactTarget)).toBe(true);
    expect(isGeneratedOrUnstableSelector('[data-reactid="4815162342"]')).toBe(true);
    expect(isGeneratedOrUnstableSelector('.css-1a2b3c4d')).toBe(true);
    expect(isGeneratedOrUnstableSelector('[data-testid="email"]')).toBe(false);
  });

  it('cross-checks implicit roles, associated labels, exposure and test ids', () => {
    document.body.innerHTML = `
      <label for="email">Work email</label>
      <input id="email" name="email" data-testid="work-email" placeholder="name@example.com" />
      <button hidden>Hidden action</button>
    `;
    const input = document.querySelector('#email');
    const hiddenButton = document.querySelector('button');
    const inputFacts = crossCheckElementSemantics(document, input);
    const hiddenFacts = crossCheckElementSemantics(document, hiddenButton);

    expect(inputFacts.exposed).toBe(true);
    expect(inputFacts.roles).toContain('textbox');
    expect(inputFacts.labels).toEqual(['Work email']);
    expect(inputFacts.placeholder).toBe('name@example.com');
    expect(inputFacts.testIds).toEqual({ 'data-testid': 'work-email' });
    expect(inputFacts.suggestions.role).toEqual(
      expect.objectContaining({
        method: 'getByRole',
        name: 'Role',
      }),
    );
    expect(inputFacts.suggestions.label).toEqual(
      expect.objectContaining({
        method: 'getByLabelText',
        name: 'LabelText',
      }),
    );
    expect(inputFacts.suggestions.placeholder).toEqual(
      expect.objectContaining({
        method: 'getByPlaceholderText',
        name: 'PlaceholderText',
      }),
    );
    expect(inputFacts.suggestions.testId).toEqual(
      expect.objectContaining({
        method: 'getByTestId',
        name: 'TestId',
      }),
    );
    expect(inputFacts.semanticLocatorAppropriate).toBe(true);
    const descriptors = buildAuthoritativeCandidateDescriptors({
      analysis: { ok: true, ...inputFacts },
      capture: {
        captured: true,
        identity: { backendNodeId: 820 },
        accessibility: { role: 'textbox', name: 'Work email' },
      },
    });
    expect(descriptors.map((candidate) => candidate.strategy)).toEqual(
      expect.arrayContaining(['testid', 'role', 'label', 'placeholder']),
    );
    expect(hiddenFacts.exposed).toBe(false);
    expect(hiddenFacts.semanticLocatorAppropriate).toBe(false);
  });

  it('returns an explicit non-semantic result for invalid targets', () => {
    expect(crossCheckElementSemantics(document, null)).toEqual(
      expect.objectContaining({
        exposed: false,
        roles: [],
        semanticLocatorAppropriate: false,
      }),
    );
    expect(generateDeterministicCssCandidates(null)).toEqual([]);
  });

  it('preserves the complete deterministic candidate tier order', () => {
    const descriptors = buildAuthoritativeCandidateDescriptors({
      capture: {
        captured: true,
        identity: { backendNodeId: 901 },
        accessibility: { role: 'textbox', name: 'Work email' },
      },
      analysis: {
        ok: true,
        exposed: true,
        testIds: { 'data-testid': 'work-email' },
        roles: ['textbox'],
        labels: ['Work email'],
        placeholder: 'name@example.com',
        suggestions: {
          role: { method: 'getByRole', args: ['textbox', { name: 'Work email' }] },
          label: { method: 'getByLabelText', args: ['Work email'] },
          placeholder: { method: 'getByPlaceholderText', args: ['name@example.com'] },
        },
        stableAttributes: { name: 'email' },
        scopeSelectors: ['main'],
        generatedCss: ['input[name="email"]'],
        xpath: '/html/body/main/input',
      },
    });

    const firstPriorityByStrategy = {};
    for (const candidate of descriptors) {
      if (firstPriorityByStrategy[candidate.strategy] == null) {
        firstPriorityByStrategy[candidate.strategy] = candidate.priority;
      }
    }
    expect(firstPriorityByStrategy).toMatchObject({
      testid: 1,
      role: 2,
      label: 3,
      placeholder: 4,
      stable_attribute: 5,
      scoped_semantic: 6,
      generated_css: 7,
      verified_xpath: 8,
    });
    expect(descriptors.map((candidate) => candidate.priority)).toEqual(
      [...descriptors].map((candidate) => candidate.priority).sort((a, b) => a - b),
    );
  });

  it.each([
    {
      title: 'role disagreement',
      suggestions: {
        role: { method: 'getByRole', args: ['button', { name: 'Work email' }] },
        label: { method: 'getByLabelText', args: ['Work email'] },
        placeholder: { method: 'getByPlaceholderText', args: ['name@example.com'] },
      },
      rejected: 'role',
    },
    {
      title: 'label disagreement',
      suggestions: {
        role: { method: 'getByRole', args: ['textbox', { name: 'Work email' }] },
        label: { method: 'getByLabelText', args: ['Different label'] },
        placeholder: { method: 'getByPlaceholderText', args: ['name@example.com'] },
      },
      rejected: 'label',
    },
    {
      title: 'placeholder disagreement',
      suggestions: {
        role: { method: 'getByRole', args: ['textbox', { name: 'Work email' }] },
        label: { method: 'getByLabelText', args: ['Work email'] },
        placeholder: { method: 'getByPlaceholderText', args: ['different@example.com'] },
      },
      rejected: 'placeholder',
    },
  ])('suppresses an invalid semantic candidate on $title while retaining deterministic fallbacks', ({ suggestions, rejected }) => {
    const descriptors = buildAuthoritativeCandidateDescriptors({
      capture: {
        captured: true,
        identity: { backendNodeId: 902 },
        accessibility: { role: 'textbox', name: 'Work email' },
      },
      analysis: {
        ok: true,
        exposed: true,
        testIds: { 'data-testid': 'work-email' },
        roles: ['textbox'],
        labels: ['Work email'],
        placeholder: 'name@example.com',
        suggestions,
        stableAttributes: { name: 'email' },
        scopeSelectors: ['main'],
        generatedCss: ['input[name="email"]'],
        xpath: '/html/body/main/input',
      },
    });

    expect(descriptors.some((candidate) => candidate.strategy === rejected)).toBe(false);
    expect(descriptors.some((candidate) => candidate.strategy === 'testid')).toBe(true);
    expect(descriptors.some((candidate) => candidate.strategy === 'stable_attribute')).toBe(true);
    expect(descriptors.some((candidate) => candidate.strategy === 'generated_css')).toBe(true);
    expect(descriptors.some((candidate) => candidate.strategy === 'verified_xpath')).toBe(true);
    if (rejected === 'role') {
      expect(descriptors.some((candidate) => candidate.strategy === 'scoped_semantic'
        && candidate.semantic?.strategy === 'role')).toBe(false);
    }
    if (rejected === 'label') {
      expect(descriptors.some((candidate) => candidate.strategy === 'scoped_semantic'
        && candidate.semantic?.strategy === 'label')).toBe(false);
    }
  });
});
