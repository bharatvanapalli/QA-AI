'use strict';

const boundOps = require('./bddBoundOperations');

const OPERATION_BACKED_OPS = new Set(['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains', 'downloadFile']);

function q(value) {
  return JSON.stringify(value == null ? '' : String(value));
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function operationPlan(result) {
  const plan = result && result.operationPlan;
  return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
}

function hasOperationBackedWork(plan) {
  return Array.isArray(plan && plan.operations)
    && plan.operations.some((op) => op && OPERATION_BACKED_OPS.has(op.operation));
}

function operationIdentity(operation) {
  if (!operation || typeof operation !== 'object') return '';
  return clean(
    operation.operationId
    || operation.id
    || operation.contractStepId
    || operation.sourceContractStepId,
  );
}

function operationIndex(operation, fallback) {
  for (const value of [operation && operation.sourceIndex, operation && operation.index, operation && operation.order]) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function isObservedTransition(operation) {
  const origin = clean(operation && (operation.origin || operation.source || operation.kind)).toLowerCase();
  return operation && operation.authored === false
    || /observed|inferred[_ -]?helper|context[_ -]?transition/.test(origin);
}

function droppedOperation(entry, fallbackIndex) {
  const candidate = entry && typeof entry === 'object'
    ? (entry.rawOperation || entry.sourceOperation || entry.operationData || entry.raw || entry)
    : entry;
  const source = candidate && typeof candidate === 'object'
    ? { ...candidate }
    : { operation: clean(candidate) || 'unsupportedOperation' };
  if (!clean(source.operation)) {
    source.operation = clean(entry && entry.operation) || 'unsupportedOperation';
  }
  if (source.params == null && entry && typeof entry === 'object' && entry.params != null) {
    source.params = entry.params;
  }
  source.sourceIndex = operationIndex(entry, operationIndex(source, fallbackIndex));
  source.unsupported = source.unsupported !== false;
  source.exportDiagnostic = clean(entry && (entry.reason || entry.detail || entry.message)) || 'Operation was not bound to a verified capability.';
  return source;
}

function mergeRetainedOperations(plan, bound) {
  const authored = Array.isArray(plan && plan.operations) ? plan.operations : [];
  const dropped = Array.isArray(plan && plan.dropped) ? plan.dropped : [];
  const source = [
    ...authored.map((operation, index) => ({ operation, sequence: operationIndex(operation, index), insertion: index })),
    ...dropped.map((entry, index) => {
      const operation = droppedOperation(entry, authored.length + index);
      return { operation, sequence: operation.sourceIndex, insertion: authored.length + index };
    }),
  ].sort((a, b) => a.sequence - b.sequence || a.insertion - b.insertion);

  const validated = Array.isArray(bound && bound.boundOperations) ? bound.boundOperations : [];
  const consumed = new Set();
  return source.map(({ operation }, index) => {
    const identity = operationIdentity(operation);
    let matchIndex = identity
      ? validated.findIndex((candidate, candidateIndex) => !consumed.has(candidateIndex) && operationIdentity(candidate) === identity)
      : -1;
    if (matchIndex < 0) {
      matchIndex = validated.findIndex((candidate, candidateIndex) => (
        !consumed.has(candidateIndex)
        && clean(candidate && candidate.operation) === clean(operation && operation.operation)
        && operationIndex(candidate, candidateIndex) === operationIndex(operation, index)
      ));
    }
    if (matchIndex < 0) {
      matchIndex = validated.findIndex((candidate, candidateIndex) => (
        !consumed.has(candidateIndex)
        && clean(candidate && candidate.operation) === clean(operation && operation.operation)
      ));
    }
    const matched = matchIndex >= 0 ? validated[matchIndex] : null;
    if (matchIndex >= 0) consumed.add(matchIndex);
    const authoredOperation = !isObservedTransition(operation);
    return {
      ...(matched || {}),
      ...operation,
      params: operation && operation.params != null ? operation.params : ((matched && matched.params) || {}),
      capability: (matched && matched.capability) || operation.capability || null,
      operationId: operationIdentity(operation) || operationIdentity(matched) || null,
      authored: authoredOperation,
      executable: authoredOperation,
      sourceIndex: operationIndex(operation, index),
      locatorProvenance: operation.locatorProvenance
        || operation.provenance
        || (matched && (matched.locatorProvenance || matched.provenance))
        || null,
      typedBindings: operation.typedBindings
        || operation.dataBindings
        || operation.bindings
        || (matched && (matched.typedBindings || matched.dataBindings || matched.bindings))
        || null,
      unsupported: Boolean(operation.unsupported || !matched),
    };
  });
}

function assessOperationPlan({ result, ir }) {
  const plan = operationPlan(result);
  if (!plan) return { mode: 'none', findings: [] };

  const dropped = Array.isArray(plan.dropped) ? plan.dropped : [];
  if (!hasOperationBackedWork(plan) && !dropped.length) return { mode: 'none', findings: [] };

  let bound;
  try {
    bound = boundOps.validateBoundOperations({
      operations: Array.isArray(plan.operations) ? plan.operations : [],
      capabilities: result.capabilities || [],
      dataRows: Array.isArray(ir && ir.dataRows) ? ir.dataRows : null,
      dataRow: ir && ir.dataRow,
      adapterId: 'playwright-bdd',
    });
  } catch (error) {
    bound = {
      valid: false,
      boundOperations: [],
      findings: [{
        severity: 'warn',
        rule: 'operation_binding_exception',
        detail: clean(error && error.message) || 'Operation binding raised an exception.',
      }],
    };
  }

  const findings = [
    ...(Array.isArray(bound && bound.findings) ? bound.findings : []),
    ...(plan.status === 'incomplete' || dropped.length ? [{
      severity: 'warn',
      rule: 'operation_plan_incomplete_retained',
      detail: `${dropped.length} unbound operation(s) retained as explicit authored contracts.`,
    }] : []),
  ].map((finding) => ({ ...finding, severity: 'warn' }));
  const boundOperations = mergeRetainedOperations(plan, bound);

  return {
    mode: 'operationBacked',
    block: null,
    retained: true,
    boundOperations,
    findings,
    diagnostics: findings,
    retainedOperationCount: boundOperations.length,
  };
}

function replaceFirst(content, needle, replacement) {
  const idx = String(content || '').indexOf(needle);
  if (idx < 0) return content;
  return content.slice(0, idx) + replacement + content.slice(idx + needle.length);
}

function insertBefore(content, marker, insertion) {
  const idx = String(content || '').lastIndexOf(marker);
  if (idx < 0) return content;
  return content.slice(0, idx) + insertion + content.slice(idx);
}

function tsValue(value) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$|^<([^>]+)>$/);
    if (exact) return `readData(row, ${q(exact[1] || exact[2])})`;
    return q(value);
  }
  if (Array.isArray(value)) return `[${value.map(tsValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}: ${tsValue(child)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

function operationComment(operation, prefix = '//') {
  const identity = operationIdentity(operation) || `source step ${Number(operation && operation.sourceIndex) + 1}`;
  if (operation && operation.authored === false) {
    return `${prefix} Observed transition ${identity} is retained as non-authored context evidence; no test action is emitted.`;
  }
  const provenance = clean(operation && (operation.locatorProvenance || operation.provenance));
  if (operation && operation.unsupported) {
    return `${prefix} QAAI retained authored operation ${identity}; its runtime helper reports any unsupported behavior at this exact step.`;
  }
  if (/guess|candidate|structural|llm|semantic/i.test(provenance)) {
    return `${prefix} QAAI locator note for ${identity}: ${provenance} evidence was used; replace it with a DOM-verified locator if it does not resolve.`;
  }
  return `${prefix} Authored operation ${identity}.`;
}

function emitPlaywrightOperationCalls(boundOperations) {
  const calls = [];
  calls.push('      const qaaOps = createQaaOperationRunner(page);');
  for (const op of boundOperations || []) {
    if (!op || !op.operation) continue;
    calls.push(`      ${operationComment(op)}`);
    if (op.authored === false) continue;
    calls.push(`      await qaaOps(${q(op.operation)}, ${tsValue(op.params || {})}, ${q(operationIdentity(op))});`);
  }
  return calls.join('\n') + '\n';
}

function emitPlaywrightOperationHelpers(boundOperations) {
  const bindings = JSON.stringify(boundOperations || [], null, 2);
  return `
type Criteria = { field: string; operator: string; value: string };
type Capability = { id?: string | null; capabilityId?: string | null; name?: string | null; type?: string | null; operations?: string[]; evidence?: any; pageUrl?: string | null };
type BoundOperation = { operation: string; operationId?: string | null; contractStepId?: string | null; sourceContractStepId?: string | null; sourceIndex?: number; authored?: boolean; executable?: boolean; unsupported?: boolean; locatorProvenance?: unknown; typedBindings?: unknown; params?: Record<string, unknown>; capability?: Capability | null };
type OperationState = { selectedRows: Locator[]; selectedCapability: Capability | null };

const BOUND_OPERATIONS: BoundOperation[] = ${bindings};

function cleanOp(value: unknown): string {
  return String(value ?? '').replace(/\\s+/g, ' ').trim();
}

function keyOp(value: unknown): string {
  return cleanOp(value).toLowerCase();
}

function sameField(a: unknown, b: unknown): boolean {
  return keyOp(a) === keyOp(b);
}

function envNameFromRef(kind: string, body: string): string {
  const suffix = String(body || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
  if (kind === 'fixture') return 'QAAI_FIXTURE_' + suffix;
  if (kind === 'vault') return 'QAAI_VAULT_' + suffix;
  if (kind === 'masked') return 'QAAI_MASKED_' + suffix;
  return suffix;
}

function resolveSafeRefs(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^(env|vault|fixture|masked):(.+)$/i);
    if (!match) return value;
    const kind = match[1].toLowerCase();
    const body = match[2];
    return readEnv(kind === 'env' ? body : envNameFromRef(kind, body));
  }
  if (Array.isArray(value)) return value.map(resolveSafeRefs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, child]) => [k, resolveSafeRefs(child)]));
  }
  return value;
}

function recordedLocator(page: Page, selector: string): Locator {
  const s = cleanOp(selector);
  let match = s.match(/getByRole\\(\\s*["']([^"']+)["']\\s*,\\s*\\{\\s*name:\\s*["']([^"']+)["']/i);
  if (match) return page.getByRole(match[1] as any, { name: match[2] });
  match = s.match(/getByRole\\(\\s*["']([^"']+)["']/i);
  if (match) return page.getByRole(match[1] as any);
  match = s.match(/getByText\\(\\s*["']([^"']+)["']/i);
  if (match) return page.getByText(match[1], { exact: false });
  match = s.match(/getByLabel\\(\\s*["']([^"']+)["']/i);
  if (match) return page.getByLabel(match[1]);
  match = s.match(/getByPlaceholder\\(\\s*["']([^"']+)["']/i);
  if (match) return page.getByPlaceholder(match[1]);
  match = s.match(/getByTestId\\(\\s*["']([^"']+)["']/i);
  if (match) return page.getByTestId(match[1]);
  return page.locator(s);
}

function cssSelectorOnly(selector: string): string | null {
  const s = cleanOp(selector);
  if (!s || /^getBy/i.test(s)) return null;
  return s;
}

async function uniqueVisibleOp(locator: Locator, label: string): Promise<Locator> {
  await locator.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  const count = await locator.count().catch(() => 0);
  if (count === 1) return locator;
  if (count === 0) throw new Error(label + ' did not resolve to any element.');
  throw new Error(label + ' is ambiguous: ' + count + ' match(es).');
}

function capabilityId(capability: Capability | null | undefined): string {
  return cleanOp(capability?.capabilityId || capability?.id || capability?.name || capability?.type);
}

function capabilityColumns(capability: Capability | null | undefined): Array<{ name: string; selector?: string }> {
  const raw = capability?.evidence?.columns;
  if (!Array.isArray(raw)) return [];
  return raw.map((column: any) => typeof column === 'string'
    ? { name: column }
    : { name: cleanOp(column?.name || column?.label || column?.header || column?.field), selector: cleanOp(column?.selector) || undefined })
    .filter((column) => column.name);
}

function columnFor(capability: Capability, field: string): { name: string; selector?: string; index: number } {
  const columns = capabilityColumns(capability);
  const index = columns.findIndex((column) => sameField(column.name, field));
  if (index < 0) throw new Error('Capability ' + capabilityId(capability) + ' has no verified column "' + field + '".');
  return { ...columns[index], index };
}

function operationBindingId(binding: BoundOperation): string {
  return cleanOp(binding.operationId || binding.contractStepId || binding.sourceContractStepId);
}

function bindingFor(operation: string, params: Record<string, unknown>, currentCapability?: Capability | null, operationId = ''): BoundOperation {
  if (operationId) {
    const exact = BOUND_OPERATIONS.find((binding) => binding.operation === operation && operationBindingId(binding) === operationId);
    if (exact) return exact;
  }
  if (currentCapability && ['rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'].includes(operation)) {
    const fromCurrent = BOUND_OPERATIONS.find((binding) => binding.operation === operation && capabilityId(binding.capability) === capabilityId(currentCapability));
    if (fromCurrent) return fromCurrent;
  }
  const candidates = BOUND_OPERATIONS.filter((binding) => binding.operation === operation);
  if (!candidates.length) throw new Error('No bound capability operation for ' + operation + '.');
  if (candidates.length === 1) return candidates[0];
  const field = cleanOp((params as any).field || ((params as any).criteria && (params as any).criteria[0] && (params as any).criteria[0].field));
  if (field) {
    const byField = candidates.find((binding) => binding.capability && capabilityColumns(binding.capability).some((column) => sameField(column.name, field)));
    if (byField) return byField;
  }
  const action = cleanOp((params as any).action || (params as any).target);
  if (action) {
    const byAction = candidates.find((binding) => keyOp(binding.capability?.name).includes(keyOp(action)) || keyOp(action).includes(keyOp(binding.capability?.name)));
    if (byAction) return byAction;
  }
  throw new Error('Operation ' + operation + ' has multiple candidate capabilities and no deterministic disambiguator.');
}

function rowLocator(page: Page, capability: Capability): Locator {
  const rootSelector = cleanOp(capability.evidence?.root?.selector || capability.evidence?.table?.selector || capability.evidence?.container?.selector);
  const rowSelector = cleanOp(capability.evidence?.rowSelector?.selector || capability.evidence?.row?.selector);
  if (rootSelector && rowSelector) {
    const css = cssSelectorOnly(rowSelector);
    return css ? recordedLocator(page, rootSelector).locator(css) : recordedLocator(page, rowSelector);
  }
  if (rowSelector) return recordedLocator(page, rowSelector);
  if (rootSelector) return recordedLocator(page, rootSelector).locator('tbody tr, [role="row"], [data-row], [data-testid*="row"]');
  throw new Error('Capability ' + capabilityId(capability) + ' has no rowSelector/root evidence.');
}

async function cellText(row: Locator, capability: Capability, field: string): Promise<string> {
  const column = columnFor(capability, field);
  const probes: Locator[] = [];
  if (column.selector) {
    const css = cssSelectorOnly(column.selector);
    if (css) probes.push(row.locator(css));
  }
  const attr = field.replace(/"/g, '\\"');
  probes.push(row.locator('[data-col="' + attr + '"], [data-column="' + attr + '"], [data-field="' + attr + '"], [aria-colindex="' + String(column.index + 1) + '"]'));
  probes.push(row.locator('td, [role="cell"], [role="gridcell"]').nth(column.index));
  for (const probe of probes) {
    const count = await probe.count().catch(() => 0);
    if (count > 0) {
      const text = cleanOp(await probe.first().innerText().catch(async () => await probe.first().textContent()));
      if (text) return text;
    }
  }
  return '';
}

function numberValue(text: string): number {
  const n = Number(cleanOp(text).replace(/[^0-9.\\-]+/g, ''));
  if (!Number.isFinite(n)) throw new Error('Cannot rank non-numeric value "' + text + '".');
  return n;
}

function matchesCriterion(actual: string, criterion: Criteria): boolean {
  const left = cleanOp(actual);
  const right = cleanOp(criterion.value);
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  switch (criterion.operator) {
    case 'equals': return l === r;
    case 'not_equals': return l !== r;
    case 'contains': return l.includes(r);
    case 'not_contains': return !l.includes(r);
    case 'starts_with': return l.startsWith(r);
    case 'ends_with': return l.endsWith(r);
    case 'gt': return numberValue(left) > numberValue(right);
    case 'lt': return numberValue(left) < numberValue(right);
    case 'gte': return numberValue(left) >= numberValue(right);
    case 'lte': return numberValue(left) <= numberValue(right);
    case 'in': return right.split(',').map((x) => keyOp(x)).includes(l);
    default: throw new Error('Unsupported criteria operator: ' + criterion.operator);
  }
}

async function matchingRows(page: Page, capability: Capability, criteria: Criteria[]): Promise<Locator[]> {
  if (!Array.isArray(criteria) || !criteria.length) throw new Error('criteria must contain at least one row.');
  const rows = rowLocator(page, capability);
  const count = await rows.count().catch(() => 0);
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    let ok = true;
    for (const criterion of criteria) {
      const text = await cellText(row, capability, criterion.field);
      if (!matchesCriterion(text, criterion)) { ok = false; break; }
    }
    if (ok) matches.push(row);
  }
  return matches;
}

function createQaaOperationRunner(page: Page): (operation: string, params: Record<string, unknown>) => Promise<void> {
  const state: OperationState = { selectedRows: [], selectedCapability: null };
  return async (operation: string, params: Record<string, unknown>, operationId = '') => {
    const resolved = resolveSafeRefs(params) as Record<string, unknown>;
    if (operation === 'authenticateAs') return;
    if (operation === 'navigateToModule') {
      const module = cleanOp(resolved.module);
      await (await uniqueVisibleOp(page.getByRole('link', { name: module }).or(page.getByRole('button', { name: module })).or(page.getByText(module, { exact: true })), 'module navigation "' + module + '"')).click();
      return;
    }
    if (operation === 'assertVisibleText') {
      await assertTextPresent(page, cleanOp(resolved.text), 'operation.assertVisibleText', 8000);
      return;
    }
    if (operation === 'fillField') {
      const binding = bindingFor('fillField', resolved, null, operationId);
      const cap = binding.capability;
      const field = cleanOp(resolved.field);
      const match = Array.isArray(cap?.evidence?.fields) ? cap.evidence.fields.find((f: any) => sameField(f.label || f.name || f.field, field)) : null;
      const selector = cleanOp(match?.selector);
      if (!selector) throw new Error('No verified selector for form field "' + field + '".');
      await (await uniqueVisibleOp(recordedLocator(page, selector), 'field "' + field + '"')).fill(cleanOp(resolved.value));
      return;
    }
    if (operation === 'submitForm') {
      const binding = bindingFor('submitForm', resolved, null, operationId);
      const selector = cleanOp(binding.capability?.evidence?.submit?.selector || binding.capability?.evidence?.button?.selector);
      if (!selector) throw new Error('No verified submit selector for ' + capabilityId(binding.capability) + '.');
      await (await uniqueVisibleOp(recordedLocator(page, selector), 'form submit')).click();
      return;
    }
    if (operation === 'selectEntityWhere') {
      const binding = bindingFor('selectEntityWhere', resolved, null, operationId);
      if (!binding.capability) throw new Error('selectEntityWhere requires a verified entity_collection capability.');
      state.selectedRows = await matchingRows(page, binding.capability, resolved.criteria as Criteria[]);
      state.selectedCapability = binding.capability;
      if (!state.selectedRows.length) throw new Error('No ' + (cleanOp(resolved.entity) || 'entity') + ' row matched the approved criteria.');
      return;
    }
    if (operation === 'rankByMin' || operation === 'rankByMax') {
      const field = cleanOp(resolved.field);
      const binding = bindingFor(operation, resolved, state.selectedCapability, operationId);
      const cap = binding.capability || state.selectedCapability;
      if (!cap) throw new Error(operation + ' needs a current selected entity collection.');
      const source = state.selectedRows.length ? state.selectedRows : await matchingRows(page, cap, [{ field, operator: 'not_equals', value: '__QAAI_IMPOSSIBLE_EMPTY_SENTINEL__' }]);
      let best: { row: Locator; value: number } | null = null;
      for (const row of source) {
        const value = numberValue(await cellText(row, cap, field));
        if (!best || (operation === 'rankByMin' ? value < best.value : value > best.value)) best = { row, value };
      }
      if (!best) throw new Error('No rows available to rank by ' + field + '.');
      state.selectedRows = [best.row];
      state.selectedCapability = cap;
      return;
    }
    if (operation === 'chooseSelected') {
      bindingFor('chooseSelected', resolved, state.selectedCapability, operationId);
      if (state.selectedRows.length !== 1) throw new Error('chooseSelected requires exactly one selected row; found ' + state.selectedRows.length + '.');
      await state.selectedRows[0].scrollIntoViewIfNeeded();
      return;
    }
    if (operation === 'assertTableContains') {
      const binding = bindingFor('assertTableContains', resolved, state.selectedCapability, operationId);
      const cap = binding.capability || state.selectedCapability;
      if (!cap) throw new Error('assertTableContains requires a verified entity_collection capability.');
      const matches = await matchingRows(page, cap, resolved.criteria as Criteria[]);
      expect(matches.length, 'expected table/entity collection to contain matching row').toBeGreaterThan(0);
      return;
    }
    if (operation === 'invokeAction') {
      const action = cleanOp(resolved.action);
      const binding = bindingFor('invokeAction', resolved, null, operationId);
      const selector = cleanOp(binding.capability?.evidence?.action?.selector || binding.capability?.evidence?.button?.selector || binding.capability?.evidence?.submit?.selector);
      if (!selector) throw new Error('No verified selector for action "' + action + '".');
      const css = cssSelectorOnly(selector);
      if (css && state.selectedRows.length === 1) {
        const scoped = state.selectedRows[0].locator(css);
        if (await scoped.count().catch(() => 0)) {
          await (await uniqueVisibleOp(scoped, 'selected-row action "' + action + '"')).click();
          return;
        }
      }
      await (await uniqueVisibleOp(recordedLocator(page, selector), 'action "' + action + '"')).click();
      return;
    }
    if (operation === 'downloadFile') {
      const target = cleanOp(resolved.target || 'current');
      const binding = bindingFor('downloadFile', resolved, null, operationId);
      const selector = cleanOp(binding.capability?.evidence?.control?.selector || binding.capability?.evidence?.action?.selector || binding.capability?.evidence?.button?.selector);
      if (!selector) throw new Error('No verified download selector for "' + target + '".');
      const control = await uniqueVisibleOp(recordedLocator(page, selector), 'download "' + target + '"');
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
      await control.click();
      const download = await downloadPromise;
      const dir = path.join(process.cwd(), 'test-results', 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      await download.saveAs(path.join(dir, download.suggestedFilename()));
      return;
    }
    throw new Error('Authored operation ' + (operationId || operation) + ' is retained but its operation-backed helper does not yet support "' + operation + '".');
  };
}
`;
}

function augmentPlaywright(content, boundOperations) {
  if (!boundOperations || !boundOperations.length) return content;
  let out = replaceFirst(content, "import { test, expect, type Locator, type Page } from '@playwright/test';", "import { test, expect, type Locator, type Page } from '@playwright/test';\nimport fs from 'node:fs';\nimport path from 'node:path';");
  out = replaceFirst(out, '\ntest.describe(', emitPlaywrightOperationHelpers(boundOperations) + '\ntest.describe(');
  out = insertBefore(out, '      await page.screenshot', emitPlaywrightOperationCalls(boundOperations));
  return out;
}

function javaValue(value) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$|^<([^>]+)>$/);
    if (exact) return `rowValue(row, ${q(exact[1] || exact[2])})`;
    return `resolveString(${q(value)})`;
  }
  if (Array.isArray(value)) {
    const criteria = value.every((item) => item && typeof item === 'object' && 'field' in item && 'operator' in item && 'value' in item);
    if (criteria) return `List.of(${value.map((item) => `new Criteria(${q(item.field)}, ${q(item.operator)}, ${javaValue(item.value)})`).join(', ')})`;
    return `List.of(${value.map(javaValue).join(', ')})`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, child]) => `${q(key)}, ${javaValue(child)}`);
    return `mapOf(${entries.join(', ')})`;
  }
  return q(value);
}

function emitJavaOperationCalls(boundOperations) {
  const calls = ['    Map<String, String> row = qaaOperationRow();'];
  for (const op of boundOperations || []) {
    if (!op || !op.operation) continue;
    calls.push(`    ${operationComment(op)}`);
    if (op.authored === false) continue;
    calls.push(`    runQaaOperation(${q(op.operation)}, ${javaValue(op.params || {})}, ${q(operationIdentity(op))});`);
  }
  return calls.join('\n') + '\n';
}

function javaRowFields(ir) {
  const row = ir && (ir.dataRow || (Array.isArray(ir.dataRows) ? ir.dataRows[0] : null));
  return row && row.fields && typeof row.fields === 'object' ? row.fields : {};
}

function javaCapabilities(boundOperations) {
  const byId = new Map();
  for (const op of boundOperations || []) {
    const cap = op && op.capability;
    const id = clean(cap && (cap.capabilityId || cap.id || cap.name));
    if (id && !byId.has(id)) byId.set(id, cap);
  }
  return [...byId.entries()].map(([id, cap]) => {
    const evidence = cap && cap.evidence || {};
    const root = clean(evidence.root && evidence.root.selector || evidence.table && evidence.table.selector || evidence.container && evidence.container.selector);
    const row = clean(evidence.rowSelector && evidence.rowSelector.selector || evidence.row && evidence.row.selector);
    const control = clean(evidence.control && evidence.control.selector);
    const action = clean(evidence.action && evidence.action.selector);
    const button = clean(evidence.button && evidence.button.selector);
    const submit = clean(evidence.submit && evidence.submit.selector);
    const columns = Array.isArray(evidence.columns) ? evidence.columns : [];
    const colText = columns.map((column) => {
      const name = typeof column === 'string' ? column : (column && (column.name || column.label || column.header || column.field));
      const selector = typeof column === 'string' ? '' : (column && column.selector);
      return `new Column(${q(name)}, ${q(selector)})`;
    }).join(', ');
    return `    caps.put(${q(id)}, new Capability(${q(id)}, ${q(cap && cap.name)}, ${q(cap && cap.type)}, ${q(root)}, ${q(row)}, ${q(control)}, ${q(action)}, ${q(button)}, ${q(submit)}, new Column[]{ ${colText} }));`;
  }).join('\n');
}

function emitJavaOperationHelpers(boundOperations, ir) {
  const rowFields = javaRowFields(ir);
  const rowPuts = Object.entries(rowFields).map(([key, value]) => `    row.put(${q(key)}, ${q(value)});`).join('\n');
  const capPuts = javaCapabilities(boundOperations);
  return `
  private static final class Criteria {
    final String field; final String operator; final String value;
    Criteria(String field, String operator, String value) { this.field = field; this.operator = operator; this.value = value; }
  }

  private static final class Column {
    final String name; final String selector;
    Column(String name, String selector) { this.name = name; this.selector = selector == null ? "" : selector; }
  }

  private static final class Capability {
    final String id; final String name; final String type; final String rootSelector; final String rowSelector;
    final String controlSelector; final String actionSelector; final String buttonSelector; final String submitSelector;
    final Column[] columns;
    Capability(String id, String name, String type, String rootSelector, String rowSelector, String controlSelector, String actionSelector, String buttonSelector, String submitSelector, Column[] columns) {
      this.id = id; this.name = name; this.type = type; this.rootSelector = rootSelector == null ? "" : rootSelector;
      this.rowSelector = rowSelector == null ? "" : rowSelector;
      this.controlSelector = controlSelector == null ? "" : controlSelector;
      this.actionSelector = actionSelector == null ? "" : actionSelector;
      this.buttonSelector = buttonSelector == null ? "" : buttonSelector;
      this.submitSelector = submitSelector == null ? "" : submitSelector;
      this.columns = columns == null ? new Column[]{} : columns;
    }
  }

  private final List<WebElement> qaaSelectedRows = new ArrayList<>();
  private Capability qaaSelectedCapability = null;

  private Map<String, String> qaaOperationRow() {
    Map<String, String> row = new LinkedHashMap<>();
${rowPuts}
    return row;
  }

  private Map<String, Capability> qaaCapabilities() {
    Map<String, Capability> caps = new LinkedHashMap<>();
${capPuts}
    return caps;
  }

  private Capability capabilityFor(String id) {
    Capability cap = qaaCapabilities().get(id);
    if (cap == null) throw new IllegalStateException("No verified capability " + id + " in exported operation plan.");
    return cap;
  }

  private String rowValue(Map<String, String> row, String field) {
    String value = row.get(field);
    if (value == null || value.isBlank()) throw new IllegalStateException("Missing data field " + field + " for operation-backed replay.");
    return resolveString(value);
  }

  private String resolveString(String value) {
    if (value == null) return "";
    Matcher matcher = Pattern.compile("^(env|vault|fixture|masked):(.+)$", Pattern.CASE_INSENSITIVE).matcher(value);
    if (!matcher.matches()) return value;
    String kind = matcher.group(1).toLowerCase();
    String body = matcher.group(2);
    String envName = kind.equals("env") ? body : envNameFromRef(kind, body);
    return EnvReader.read(envName);
  }

  private String envNameFromRef(String kind, String body) {
    String suffix = (body == null ? "" : body).toUpperCase().replaceAll("[^A-Z0-9]+", "_").replaceAll("^_+|_+$", "");
    if (suffix.isBlank()) suffix = "VALUE";
    if (kind.equals("fixture")) return "QAAI_FIXTURE_" + suffix;
    if (kind.equals("vault")) return "QAAI_VAULT_" + suffix;
    if (kind.equals("masked")) return "QAAI_MASKED_" + suffix;
    return suffix;
  }

  private Map<String, Object> mapOf(Object... pairs) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (int i = 0; i + 1 < pairs.length; i += 2) out.put(String.valueOf(pairs[i]), pairs[i + 1]);
    return out;
  }

  @SuppressWarnings("unchecked")
  private void runQaaOperation(String operation, Map<String, Object> params, String operationId) throws Exception {
    if (operation.equals("authenticateAs")) return;
    if (operation.equals("navigateToModule")) { clickUnique(LocatorResolver.textContains(String.valueOf(params.get("module"))), "module navigation"); return; }
    if (operation.equals("assertVisibleText")) { Assert.assertTrue(seesText(String.valueOf(params.get("text"))), "operation assertVisibleText"); return; }
    if (operation.equals("selectEntityWhere")) {
      Capability cap = boundCapability(operation, params, null, operationId);
      qaaSelectedRows.clear();
      qaaSelectedRows.addAll(matchingRows(cap, (List<Criteria>) params.get("criteria")));
      qaaSelectedCapability = cap;
      if (qaaSelectedRows.isEmpty()) throw new IllegalStateException("No entity row matched the approved criteria.");
      return;
    }
    if (operation.equals("rankByMin") || operation.equals("rankByMax")) { rankBy(String.valueOf(params.get("field")), operation.equals("rankByMin")); return; }
    if (operation.equals("chooseSelected")) {
      if (qaaSelectedRows.size() != 1) throw new IllegalStateException("chooseSelected requires exactly one selected row; found " + qaaSelectedRows.size());
      return;
    }
    if (operation.equals("assertTableContains")) {
      Capability cap = boundCapability(operation, params, qaaSelectedCapability, operationId);
      Assert.assertFalse(matchingRows(cap, (List<Criteria>) params.get("criteria")).isEmpty(), "expected table/entity collection to contain matching row");
      return;
    }
    if (operation.equals("downloadFile")) {
      Capability cap = boundCapability(operation, params, null, operationId);
      String selector = firstNonBlank(selectorFrom(cap, "control"), selectorFrom(cap, "action"), selectorFrom(cap, "button"));
      clickUnique(firstBy(selector), "download " + params.getOrDefault("target", "current"));
      return;
    }
    throw new IllegalStateException("Authored operation " + (operationId.isBlank() ? operation : operationId) + " is retained but its operation-backed helper does not yet support " + operation + ".");
  }

  private Capability boundCapability(String operation, Map<String, Object> params, Capability current, String operationId) {
    if (operationId != null && !operationId.isBlank()) {
      for (BoundRef ref : boundRefs()) {
        if (ref.operation.equals(operation) && ref.operationId.equals(operationId)) return capabilityFor(ref.capabilityId);
      }
    }
    if (current != null && List.of("rankByMin", "rankByMax", "chooseSelected", "assertTableContains").contains(operation)) return current;
    for (BoundRef ref : boundRefs()) {
      if (ref.operation.equals(operation)) return capabilityFor(ref.capabilityId);
    }
    throw new IllegalStateException("No bound capability operation for " + operation);
  }

  private static final class BoundRef {
    final String operation; final String operationId; final String capabilityId;
    BoundRef(String operation, String operationId, String capabilityId) { this.operation = operation; this.operationId = operationId; this.capabilityId = capabilityId; }
  }
  private List<BoundRef> boundRefs() { return List.of(
${(boundOperations || []).filter((op) => op && op.capability).map((op) => `    new BoundRef(${q(op.operation)}, ${q(operationIdentity(op))}, ${q(op.capability.capabilityId || op.capability.id || op.capability.name)})`).join(',\n')}
  ); }

  private String selectorFrom(Capability cap, String key) {
    if (cap == null) return "";
    if ("control".equals(key)) return cap.controlSelector;
    if ("action".equals(key)) return cap.actionSelector;
    if ("button".equals(key)) return cap.buttonSelector;
    if ("submit".equals(key)) return cap.submitSelector;
    if ("row".equals(key)) return cap.rowSelector;
    if ("root".equals(key)) return cap.rootSelector;
    return "";
  }

  private String firstNonBlank(String... values) {
    for (String value : values) if (value != null && !value.isBlank()) return value;
    return "";
  }

  private By firstBy(String selector) {
    List<By> bys = selectorToBys(selector);
    if (bys.isEmpty()) throw new IllegalStateException("No deterministic By for selector " + selector);
    return bys.get(0);
  }

  private List<WebElement> elementsForSelector(String selector) {
    for (By by : selectorToBys(selector)) {
      List<WebElement> found = driver.findElements(by);
      if (!found.isEmpty()) return found;
    }
    return List.of();
  }

  private void clickUnique(By by, String label) {
    List<WebElement> found = driver.findElements(by);
    List<WebElement> visible = new ArrayList<>();
    for (WebElement el : found) if (el.isDisplayed()) visible.add(el);
    if (visible.size() != 1) throw new IllegalStateException(label + " is ambiguous or missing: visible count=" + visible.size());
    visible.get(0).click();
  }

  private List<By> selectorToBys(String selector) {
    String s = selector == null ? "" : selector.trim();
    if (s.isEmpty()) return List.of();
    Matcher role = Pattern.compile("getByRole\\\\(\\\\s*[\\"']([^\\\"']+)[\\"'](?:\\\\s*,\\\\s*\\\\{\\\\s*name:\\\\s*[\\"']([^\\\"']+)[\\"'])?", Pattern.CASE_INSENSITIVE).matcher(s);
    if (role.find()) return LocatorResolver.bysForRole(role.group(1), role.group(2));
    Matcher text = Pattern.compile("getByText\\\\(\\\\s*[\\"']([^\\\"']+)[\\"']", Pattern.CASE_INSENSITIVE).matcher(s);
    if (text.find()) return List.of(LocatorResolver.textContains(text.group(1)));
    Matcher testId = Pattern.compile("getByTestId\\\\(\\\\s*[\\"']([^\\\"']+)[\\"']", Pattern.CASE_INSENSITIVE).matcher(s);
    if (testId.find()) return List.of(By.xpath("//*[@data-testid=" + LocatorResolver.xpathLiteral(testId.group(1)) + " or @data-test-id=" + LocatorResolver.xpathLiteral(testId.group(1)) + "]"));
    Matcher placeholder = Pattern.compile("getByPlaceholder\\\\(\\\\s*[\\"']([^\\\"']+)[\\"']", Pattern.CASE_INSENSITIVE).matcher(s);
    if (placeholder.find()) return List.of(By.xpath("//*[@placeholder=" + LocatorResolver.xpathLiteral(placeholder.group(1)) + "]"));
    return List.of(By.cssSelector(s));
  }

  private List<WebElement> rowElements(Capability cap) {
    if (!cap.rowSelector.isBlank()) return elementsForSelector(cap.rowSelector);
    if (!cap.rootSelector.isBlank()) return elementsForSelector(cap.rootSelector);
    throw new IllegalStateException("Capability " + cap.id + " has no row/root selector evidence.");
  }

  private Column columnFor(Capability cap, String field) {
    for (int i = 0; i < cap.columns.length; i++) if (sameField(cap.columns[i].name, field)) return cap.columns[i];
    throw new IllegalStateException("Capability " + cap.id + " has no verified column " + field);
  }

  private String cellText(WebElement row, Capability cap, String field) {
    Column column = columnFor(cap, field);
    if (!column.selector.isBlank() && !column.selector.startsWith("getBy")) {
      List<WebElement> found = row.findElements(By.cssSelector(column.selector));
      if (!found.isEmpty()) return found.get(0).getText();
    }
    List<WebElement> cells = row.findElements(By.cssSelector("td, [role='cell'], [role='gridcell']"));
    int index = Math.max(0, Arrays.asList(cap.columns).indexOf(column));
    return index < cells.size() ? cells.get(index).getText() : "";
  }

  private List<WebElement> matchingRows(Capability cap, List<Criteria> criteria) {
    List<WebElement> matches = new ArrayList<>();
    for (WebElement row : rowElements(cap)) {
      boolean ok = true;
      for (Criteria criterion : criteria) if (!matchesCriterion(cellText(row, cap, criterion.field), criterion)) { ok = false; break; }
      if (ok) matches.add(row);
    }
    return matches;
  }

  private void rankBy(String field, boolean min) {
    Capability cap = qaaSelectedCapability;
    if (cap == null) throw new IllegalStateException("rankBy needs a current selected entity collection.");
    List<WebElement> source = qaaSelectedRows.isEmpty() ? rowElements(cap) : new ArrayList<>(qaaSelectedRows);
    WebElement best = null; double bestValue = 0;
    for (WebElement row : source) {
      double value = numberValue(cellText(row, cap, field));
      if (best == null || (min ? value < bestValue : value > bestValue)) { best = row; bestValue = value; }
    }
    if (best == null) throw new IllegalStateException("No rows available to rank by " + field);
    qaaSelectedRows.clear(); qaaSelectedRows.add(best);
  }

  private boolean matchesCriterion(String actual, Criteria criterion) {
    String l = actual == null ? "" : actual.trim().toLowerCase();
    String r = criterion.value == null ? "" : criterion.value.trim().toLowerCase();
    switch (criterion.operator) {
      case "equals": return l.equals(r);
      case "not_equals": return !l.equals(r);
      case "contains": return l.contains(r);
      case "not_contains": return !l.contains(r);
      case "starts_with": return l.startsWith(r);
      case "ends_with": return l.endsWith(r);
      case "gt": return numberValue(l) > numberValue(r);
      case "lt": return numberValue(l) < numberValue(r);
      case "gte": return numberValue(l) >= numberValue(r);
      case "lte": return numberValue(l) <= numberValue(r);
      case "in": return Arrays.asList(r.split(",")).contains(l);
      default: throw new IllegalStateException("Unsupported criteria operator: " + criterion.operator);
    }
  }

  private boolean sameField(String a, String b) { return a != null && b != null && a.trim().equalsIgnoreCase(b.trim()); }
  private double numberValue(String text) { return Double.parseDouble((text == null ? "" : text).replaceAll("[^0-9.\\\\-]+", "")); }
`;
}

function augmentSelenium(content, boundOperations, ir) {
  if (!boundOperations || !boundOperations.length) return content;
  let out = content;
  out = replaceFirst(out, 'import org.testng.annotations.Test;\nimport java.time.Duration;', 'import org.testng.annotations.Test;\nimport org.openqa.selenium.By;\nimport org.openqa.selenium.WebElement;\nimport java.time.Duration;\nimport java.util.ArrayList;\nimport java.util.Arrays;\nimport java.util.LinkedHashMap;\nimport java.util.List;\nimport java.util.Map;\nimport java.util.regex.Matcher;\nimport java.util.regex.Pattern;');
  out = insertBefore(out, '    captureScreenshot', emitJavaOperationCalls(boundOperations));
  out = insertBefore(out, '\n}', emitJavaOperationHelpers(boundOperations, ir));
  return out;
}

module.exports = {
  OPERATION_BACKED_OPS,
  assessOperationPlan,
  augmentPlaywright,
  augmentSelenium,
  hasOperationBackedWork,
};
