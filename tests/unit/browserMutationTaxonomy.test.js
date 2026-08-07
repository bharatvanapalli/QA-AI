import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const taxonomy = require('../../server/services/browserMutationTaxonomy');
const registry = require('../../server/services/browserActionRegistry');

describe('canonical browser mutation taxonomy', () => {
  it('classifies every always-mutating operation through one exported set', () => {
    for (const toolName of taxonomy.ALWAYS_MUTATING_BROWSER_TOOLS) {
      expect(taxonomy.isMutatingTool(toolName, {}), toolName).toBe(true);
      expect(taxonomy.mutationPolicyForTool(toolName), toolName).toBe(taxonomy.MUTATION_POLICY.MUTATION);
    }
  });

  it('separates observation-only tools and conditional tab/CDP operations', () => {
    for (const toolName of taxonomy.OBSERVATION_ONLY_BROWSER_TOOLS) {
      expect(taxonomy.isMutatingTool(toolName, {}), toolName).toBe(false);
      expect(taxonomy.isObservationOnlyTool(toolName, {}), toolName).toBe(true);
    }
    expect(taxonomy.isMutatingTool('browser_tabs', { action: 'list' })).toBe(false);
    expect(taxonomy.isMutatingTool('browser_tabs', { action: 'select', index: 1 })).toBe(true);
    expect(taxonomy.isMutatingTool('browser_execute_cdp_command', { command: 'DOM.describeNode' })).toBe(false);
    expect(taxonomy.isMutatingTool('browser_execute_cdp_command', { command: 'Network.setCookies' })).toBe(true);
  });

  it.each([
    '() => node.click()',
    '() => { input.value = "x"; }',
    '() => node.classList.toggle("open")',
    '() => { node.style.display = "none"; }',
    '() => { node.dataset.state = "ready"; }',
    '() => node.insertAdjacentHTML("beforeend", "<b>x</b>")',
    '() => localStorage.setItem("key", "value")',
    '() => { document.cookie = "a=b"; }',
    '() => history.pushState({}, "", "/next")',
    '() => { window.location.href = "/next"; }',
    '() => node.dispatchEvent(new InputEvent("input"))',
  ])('treats executable mutation source as a permit-requiring action: %s', (source) => {
    expect(taxonomy.isMutatingTool('browser_evaluate', { function: source })).toBe(true);
  });

  it('keeps pure executable readback in the observation lane', () => {
    expect(taxonomy.isMutatingTool('browser_evaluate', {
      function: '() => ({ title: document.title, href: location.href })',
    })).toBe(false);
    expect(taxonomy.isObservationOnlyTool('browser_evaluate', {
      function: '() => document.querySelector("input")?.value',
    })).toBe(true);
    expect(taxonomy.isObservationOnlyTool('browser_evaluate', {
      function: '(element) => ({ value: element.value == null ? "" : element.value, checked: element.checked === true })',
    })).toBe(true);
  });

  it('drives registry mutation policy without a competing mutator list', () => {
    expect(registry.validateRegistry()).toEqual([]);
    expect(registry.getActionEntry('browser_hover')).toMatchObject({
      mutationPolicy: taxonomy.MUTATION_POLICY.MUTATION,
      mutatesPage: true,
    });
    expect(registry.getActionEntry('browser_scroll')).toMatchObject({
      mutationPolicy: taxonomy.MUTATION_POLICY.MUTATION,
      mutatesPage: true,
    });
    expect(registry.getActionEntry('browser_evaluate')).toMatchObject({
      mutationPolicy: taxonomy.MUTATION_POLICY.CONDITIONAL,
      mutatesPage: false,
    });
  });
});
