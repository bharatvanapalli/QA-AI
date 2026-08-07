'use strict';

const registry = require('./bddStepRegistry');

const BASE_PACKAGE = 'com.qaai';
const PKG_PATH = 'com/qaai';

function finding(rule, severity, message, path = null) {
  return { rule, severity, message, path, engine: 'bdd-glue-emitter' };
}

function cleanName(value) {
  return String(value || '').trim();
}

function operationList(operations) {
  const keys = Array.isArray(operations) && operations.length
    ? operations.map((op) => (typeof op === 'string' ? op : op && op.operation)).filter(Boolean)
    : registry.registryKeys();
  return [...new Set(keys)];
}

function validateOperationSet(operations, adapterId, bindingMetadata = null) {
  const findings = [];
  const source = Array.isArray(operations) ? operations : [];
  const normalized = source.map((item, index) => {
    const op = typeof item === 'string' ? item : item && item.operation;
    const entry = registry.getStep(op);
    if (entry && registry.adapterSupports(adapterId, op)) return item;
    findings.push(entry
      ? finding('bdd_adapter_unsupported_operation', 'error', `Adapter "${adapterId}" does not support "${op}".`, `operations[${index}]`)
      : finding('bdd_registry_missing_operation', 'error', `Operation "${op || 'unknown'}" has no canonical BDD step.`, `operations[${index}]`));
    findings.push(finding('bdd_authored_step_fallback', 'warning', `Operation "${op || 'unknown'}" is retained through neutral authored-step glue.`, `operations[${index}]`));
    const fallbackSource = item && typeof item === 'object'
      ? item
      : {
        operation: op || 'unknown',
        action: op || 'perform',
        element: 'authored semantic target',
        provenance: { kind: 'structural_fallback', reason: 'No canonical adapter operation was available.' },
      };
    return registry.toAuthoredStep(fallbackSource, index, bindingMetadata);
  });
  const ops = operationList(normalized);
  return { ops, findings, operations: normalized };
}

function cucumberExpression(entry) {
  return entry.gherkin.replace(/\{[^}]+\}/g, '{string}');
}

function argName(raw) {
  return String(raw || '').replace(/\?$/, '');
}

function nonTableArgs(entry) {
  return (entry.args || []).map(argName).filter((arg) => arg && arg !== 'criteria');
}

function jsIdent(value, fallback = 'value') {
  const base = String(value || fallback)
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      const clean = part.replace(/[^A-Za-z0-9_$]/g, '');
      if (!clean) return '';
      return index === 0
        ? clean.charAt(0).toLowerCase() + clean.slice(1)
        : clean.charAt(0).toUpperCase() + clean.slice(1);
    })
    .join('');
  const safe = base || fallback;
  return /^[A-Za-z_$]/.test(safe) ? safe : `v${safe}`;
}

function javaString(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function tsString(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function tsStepFunction(entry) {
  const fn = entry.keyword;
  const expression = cucumberExpression(entry);
  const args = nonTableArgs(entry);
  const typedArgs = args.map((arg) => `${jsIdent(arg)}: string`);
  if (entry.table === 'criteria') typedArgs.push('dataTable: BddDataTable');
  const signatureArgs = typedArgs.length ? `, ${typedArgs.join(', ')}` : '';
  const callArgs = args.map((arg) => jsIdent(arg));
  if (entry.table === 'criteria') callArgs.push('criteriaFromDataTable(dataTable)');
  return `${fn}(${tsString(expression)}, async ({ page }${signatureArgs}) => {
  await ops(page).${entry.operation}(${callArgs.join(', ')});
});`;
}

function tsMethod(entry) {
  const args = nonTableArgs(entry);
  const typedArgs = args.map((arg) => `${jsIdent(arg)}: string`);
  if (entry.table === 'criteria') typedArgs.push('criteria: Criteria[]');
  const paramPairs = args.map((arg) => `${arg}: ${jsIdent(arg)}`);
  if (entry.table === 'criteria') paramPairs.push('criteria');
  return `  async ${entry.operation}(${typedArgs.join(', ')}): Promise<void> {
    await this.dispatch(${tsString(entry.operation)}, { ${paramPairs.join(', ')} });
  }`;
}

function emitPlaywrightSupport(ops, boundOperations = []) {
  const methods = ops.map((op) => tsMethod(registry.getStep(op))).join('\n\n');
  const operators = JSON.stringify([...registry.CRITERIA_OPERATORS]);
  const bindings = JSON.stringify((Array.isArray(boundOperations) ? boundOperations : [])
    .filter((op) => op && typeof op === 'object')
    .map((op) => ({
      operation: op.operation,
      params: op.params || {},
      capability: op.capability || null,
    })), null, 2);
  return `import type { Page } from '@playwright/test';
import { expect, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export type Criteria = { field: string; operator: string; value: string };
type BddDataTable = { hashes(): Array<Record<string, string>> };
type OperationRunner = (payload: { page: Page; operation: string; params: Record<string, unknown> }) => Promise<void> | void;
type AuthenticationRunner = (payload: { page: Page; role: string; params: Record<string, unknown> }) => Promise<void> | void;
type Capability = { id?: string | null; capabilityId?: string | null; name?: string | null; type?: string | null; operations?: string[]; evidence?: any; pageUrl?: string | null };
type BoundOperation = { operation: string; params?: Record<string, unknown>; capability?: Capability | null };

const ALLOWED_OPERATORS = new Set<string>(${operators});
const BOUND_OPERATIONS: BoundOperation[] = ${bindings};

export function criteriaFromDataTable(dataTable: BddDataTable): Criteria[] {
  const rows = dataTable.hashes();
  if (!rows.length) throw new Error('Criteria DataTable must contain at least one row.');
  return rows.map((row, index) => {
    const field = String(row.field || '').trim();
    const operator = String(row.operator || '').trim();
    const value = String(row.value ?? '').trim();
    if (!field) throw new Error(\`Criteria row \${index + 1} is missing field.\`);
    if (!ALLOWED_OPERATORS.has(operator)) throw new Error(\`Criteria row \${index + 1} has unsupported operator \${operator}.\`);
    if (value === '') throw new Error(\`Criteria row \${index + 1} is missing value.\`);
    return { field, operator, value };
  });
}

function envNameFromRef(kind: string, body: string): string {
  const suffix = String(body || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'VALUE';
  if (kind === 'fixture') return \`QAAI_FIXTURE_\${suffix}\`;
  if (kind === 'vault') return \`QAAI_VAULT_\${suffix}\`;
  if (kind === 'runtime') return \`QAAI_RUNTIME_\${suffix}\`;
  if (kind === 'dependency') return \`QAAI_DEPENDENCY_\${suffix}\`;
  if (kind === 'generated') return \`QAAI_GENERATED_\${suffix}\`;
  return suffix;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing required environment variable \${name}\`);
  return value;
}

function resolveSafeRefs(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^(env|vault|fixture|runtime|dependency|generated):(.+)$/i);
    if (!match) return value;
    const kind = match[1].toLowerCase();
    const body = match[2];
    return readEnv(kind === 'env' ? body : envNameFromRef(kind, body));
  }
  if (Array.isArray(value)) return value.map(resolveSafeRefs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveSafeRefs(child)]));
  }
  return value;
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\\s+/g, ' ').trim();
}

function key(value: unknown): string {
  return clean(value).toLowerCase();
}

function sameField(a: unknown, b: unknown): boolean {
  return key(a) === key(b);
}

function recordedLocator(page: Page, selector: string): Locator {
  const s = clean(selector);
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
  const s = clean(selector);
  if (!s || /^getBy/i.test(s)) return null;
  return s;
}

async function uniqueVisible(locator: Locator, label: string): Promise<Locator> {
  await locator.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  const count = await locator.count().catch(() => 0);
  if (count === 1) return locator;
  if (count === 0) throw new Error(label + ' did not resolve to any element.');
  throw new Error(label + ' is ambiguous: ' + count + ' match(es).');
}

function decodeAuthoredDetails(encoded: unknown): any {
  try { return JSON.parse(Buffer.from(clean(encoded), 'base64').toString('utf8')); }
  catch { return {}; }
}

function evidenceSelectors(value: unknown, out: string[] = []): string[] {
  if (!value) return out;
  if (Array.isArray(value)) { value.forEach((item) => evidenceSelectors(item, out)); return out; }
  if (typeof value !== 'object') return out;
  for (const [keyName, child] of Object.entries(value as Record<string, unknown>)) {
    if (['selector', 'expression', 'primary'].includes(keyName) && typeof child === 'string' && clean(child)) out.push(clean(child));
    else evidenceSelectors(child, out);
  }
  return [...new Set(out)];
}

async function authoredLocator(page: Page, target: string, details: any, action: string): Promise<Locator> {
  const selectors = evidenceSelectors([details.locatorRecipe, details.capabilityEvidence, details.candidates]);
  for (const selector of selectors) {
    const candidate = recordedLocator(page, selector);
    const count = await candidate.count().catch(() => 0);
    if (count === 1) return candidate;
  }
  const label = clean(target) || 'semantic page control';
  const semantic = /fill|type|enter|input|select/i.test(action)
    ? page.getByLabel(label).or(page.getByPlaceholder(label)).or(page.getByRole('textbox', { name: label }))
    : page.getByRole('button', { name: label }).or(page.getByRole('link', { name: label })).or(page.getByText(label, { exact: true }));
  return uniqueVisible(semantic, 'authored target "' + label + '"');
}

function capabilityId(capability: Capability | null | undefined): string {
  return clean(capability?.capabilityId || capability?.id || capability?.name || capability?.type);
}

function capabilityColumns(capability: Capability | null | undefined): Array<{ name: string; selector?: string }> {
  const raw = capability?.evidence?.columns;
  if (!Array.isArray(raw)) return [];
  return raw.map((column: any) => typeof column === 'string'
    ? { name: column }
    : { name: clean(column?.name || column?.label || column?.header || column?.field), selector: clean(column?.selector) || undefined })
    .filter((column) => column.name);
}

function columnFor(capability: Capability, field: string): { name: string; selector?: string; index: number } {
  const columns = capabilityColumns(capability);
  const index = columns.findIndex((column) => sameField(column.name, field));
  if (index < 0) throw new Error('Capability ' + capabilityId(capability) + ' has no verified column "' + field + '".');
  return { ...columns[index], index };
}

function bindingFor(operation: string, params: Record<string, unknown>, currentCapability?: Capability | null): BoundOperation {
  if (currentCapability && ['rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'].includes(operation)) {
    const fromCurrent = BOUND_OPERATIONS.find((binding) => binding.operation === operation && capabilityId(binding.capability) === capabilityId(currentCapability));
    if (fromCurrent) return fromCurrent;
  }
  const candidates = BOUND_OPERATIONS.filter((binding) => binding.operation === operation);
  if (!candidates.length) throw new Error('No bound capability operation for ' + operation + '.');
  if (candidates.length === 1) return candidates[0];
  const field = clean((params as any).field || ((params as any).criteria && (params as any).criteria[0] && (params as any).criteria[0].field));
  if (field) {
    const byField = candidates.find((binding) => {
      const cap = binding.capability;
      if (!cap) return false;
      return capabilityColumns(cap).some((column) => sameField(column.name, field));
    });
    if (byField) return byField;
  }
  const action = clean((params as any).action || (params as any).target);
  if (action) {
    const byAction = candidates.find((binding) => key(binding.capability?.name).includes(key(action)) || key(action).includes(key(binding.capability?.name)));
    if (byAction) return byAction;
  }
  throw new Error('Operation ' + operation + ' has multiple candidate capabilities and no deterministic disambiguator.');
}

function rowLocator(page: Page, capability: Capability): Locator {
  const rootSelector = clean(capability.evidence?.root?.selector || capability.evidence?.table?.selector || capability.evidence?.container?.selector);
  const rowSelector = clean(capability.evidence?.rowSelector?.selector || capability.evidence?.row?.selector);
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
    if (count === 1) {
      const text = clean(await probe.innerText().catch(async () => await probe.textContent()));
      if (text) return text;
    } else if (count > 1) {
      throw new Error('Column "' + field + '" is ambiguous inside the selected row: ' + count + ' matches.');
    }
  }
  return '';
}

function numberValue(text: string): number {
  const n = Number(clean(text).replace(/[^0-9.\\-]+/g, ''));
  if (!Number.isFinite(n)) throw new Error('Cannot rank non-numeric value "' + text + '".');
  return n;
}

function matchesCriterion(actual: string, criterion: Criteria): boolean {
  const left = clean(actual);
  const right = clean(criterion.value);
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
    case 'in': return right.split(',').map((x) => key(x)).includes(l);
    default: throw new Error('Unsupported criteria operator: ' + criterion.operator);
  }
}

function runner(): OperationRunner {
  const maybe = (globalThis as unknown as { __QAAI_BDD_OPERATION_RUNNER__?: OperationRunner }).__QAAI_BDD_OPERATION_RUNNER__;
  if (typeof maybe === 'function') return maybe;
  return async ({ page, operation, params }) => {
    const ops = new CapabilityOperations(page);
    await (ops as any).run(operation, params);
  };
}

export function ops(page: Page): CapabilityOperations {
  return new CapabilityOperations(page);
}

export class CapabilityOperations {
  private selectedRows: Locator[] = [];
  private selectedCapability: Capability | null = null;
  private downloads: Array<{ fileName: string; path: string }> = [];

  constructor(private readonly page: Page) {}

  private async dispatch(operation: string, params: Record<string, unknown>): Promise<void> {
    const resolved = resolveSafeRefs(params) as Record<string, unknown>;
    const maybe = (globalThis as unknown as { __QAAI_BDD_OPERATION_RUNNER__?: OperationRunner }).__QAAI_BDD_OPERATION_RUNNER__;
    if (typeof maybe === 'function') {
      await maybe({ page: this.page, operation, params: resolved });
      return;
    }
    await this.run(operation, resolved);
  }

  async run(operation: string, params: Record<string, unknown>): Promise<void> {
    if (operation === 'authenticateAs') {
      const authenticate = (globalThis as unknown as { __QAAI_BDD_AUTHENTICATOR__?: AuthenticationRunner }).__QAAI_BDD_AUTHENTICATOR__;
      if (typeof authenticate === 'function') {
        await authenticate({ page: this.page, role: clean(params.role), params });
        return;
      }
      throw new Error('QAAI_AUTHENTICATION_REQUIRED: The authored authenticateAs step requires __QAAI_BDD_AUTHENTICATOR__ or __QAAI_BDD_OPERATION_RUNNER__; authentication was not silently skipped.');
    }
    if (operation === 'navigateToModule') return this.doNavigateToModule(clean(params.module));
    if (operation === 'assertVisibleText') return this.doAssertVisibleText(clean(params.text));
    if (operation === 'fillField') return this.doFillField(clean(params.field), clean(params.value));
    if (operation === 'submitForm') return this.doSubmitForm();
    if (operation === 'selectEntityWhere') return this.doSelectEntityWhere(clean(params.entity), params.criteria as Criteria[]);
    if (operation === 'rankByMin') return this.doRankByMin(clean(params.field));
    if (operation === 'rankByMax') return this.doRankByMax(clean(params.field));
    if (operation === 'chooseSelected') return this.doChooseSelected();
    if (operation === 'assertTableContains') return this.doAssertTableContains(params.criteria as Criteria[]);
    if (operation === 'invokeAction') return this.doInvokeAction(clean(params.action));
    if (operation === 'downloadFile') return this.doDownloadFile(clean(params.target || 'current'));
    if (['authoredAction', 'authoredAssertion', 'authoredWait', 'authoredContext', 'authoredDependency'].includes(operation)) {
      return this.doAuthoredStep(operation, params);
    }
    throw new Error('Unsupported BDD operation ' + operation + '.');
  }

  private async doAuthoredStep(operation: string, params: Record<string, unknown>): Promise<void> {
    const details = decodeAuthoredDetails(params.details);
    const target = clean(params.target) || 'semantic page control';
    const value = clean(params.value) || 'no authored value';
    const action = clean(details.action || params.identity).toLowerCase();
    const soft = details.soft === true || details.optional === true;
    const perform = async (): Promise<void> => {
      if (operation === 'authoredContext' || operation === 'authoredDependency') {
        await this.page.waitForLoadState('domcontentloaded');
        return;
      }
      if (/navigate|open|visit|go to/.test(action) && details.authoredNavigation === true) {
        await this.page.goto(value);
        return;
      }
      const locator = await authoredLocator(this.page, target, details, action);
      if (operation === 'authoredWait') { await locator.waitFor({ state: 'visible', timeout: 10000 }); return; }
      if (operation === 'authoredAssertion') {
        if (value && value !== 'no authored value') await expect(locator).toContainText(value, { ignoreCase: true });
        else await expect(locator).toBeVisible();
        return;
      }
      if (/fill|type|enter|input/.test(action)) { await locator.fill(value); return; }
      if (/select|choose/.test(action)) { await locator.selectOption(value); return; }
      if (/uncheck/.test(action)) { await locator.uncheck(); return; }
      if (/check/.test(action)) { await locator.check(); return; }
      if (/hover/.test(action)) { await locator.hover(); return; }
      if (/press/.test(action)) { await locator.press(value); return; }
      await locator.click();
    };
    if (!soft) return perform();
    await perform().catch((error) => console.warn('QAAI non-blocking authored step mismatch:', error instanceof Error ? error.message : String(error)));
  }

  private async doNavigateToModule(module: string): Promise<void> {
    if (!module) throw new Error('navigateToModule needs a module name.');
    const nav = this.page.getByRole('link', { name: module }).or(this.page.getByRole('button', { name: module })).or(this.page.getByText(module, { exact: true }));
    await (await uniqueVisible(nav, 'module navigation "' + module + '"')).click();
  }

  private async doAssertVisibleText(text: string): Promise<void> {
    if (!text) throw new Error('assertVisibleText needs text.');
    await expect(this.page.getByText(text, { exact: false })).not.toHaveCount(0, { timeout: 8000 });
  }

  private async doFillField(field: string, value: string): Promise<void> {
    const binding = bindingFor('fillField', { field });
    const cap = binding.capability;
    const match = Array.isArray(cap?.evidence?.fields)
      ? cap.evidence.fields.find((f: any) => sameField(f.label || f.name || f.field, field))
      : null;
    const selector = clean(match?.selector);
    if (!selector) throw new Error('No verified selector for form field "' + field + '".');
    await (await uniqueVisible(recordedLocator(this.page, selector), 'field "' + field + '"')).fill(value);
  }

  private async doSubmitForm(): Promise<void> {
    const binding = bindingFor('submitForm', {});
    const selector = clean(binding.capability?.evidence?.submit?.selector || binding.capability?.evidence?.button?.selector);
    if (!selector) throw new Error('No verified submit selector for ' + capabilityId(binding.capability) + '.');
    await (await uniqueVisible(recordedLocator(this.page, selector), 'form submit')).click();
  }

  private async matchingRows(capability: Capability, criteria: Criteria[]): Promise<Locator[]> {
    if (!Array.isArray(criteria) || !criteria.length) throw new Error('criteria must contain at least one row.');
    const rows = rowLocator(this.page, capability);
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

  private async doSelectEntityWhere(entity: string, criteria: Criteria[]): Promise<void> {
    const binding = bindingFor('selectEntityWhere', { entity, criteria });
    if (!binding.capability) throw new Error('selectEntityWhere requires a verified entity_collection capability.');
    this.selectedRows = await this.matchingRows(binding.capability, criteria);
    this.selectedCapability = binding.capability;
    if (!this.selectedRows.length) throw new Error('No ' + (entity || 'entity') + ' row matched the approved criteria.');
  }

  private async doRankByMin(field: string): Promise<void> {
    await this.rankBy(field, 'min');
  }

  private async doRankByMax(field: string): Promise<void> {
    await this.rankBy(field, 'max');
  }

  private async rankBy(field: string, direction: 'min' | 'max'): Promise<void> {
    const binding = bindingFor(direction === 'min' ? 'rankByMin' : 'rankByMax', { field }, this.selectedCapability);
    const cap = binding.capability || this.selectedCapability;
    if (!cap) throw new Error('rankBy needs a current selected entity collection.');
    const source = this.selectedRows.length ? this.selectedRows : await this.matchingRows(cap, [{ field, operator: 'not_equals', value: '__QAAI_IMPOSSIBLE_EMPTY_SENTINEL__' }]);
    let best: { row: Locator; value: number } | null = null;
    for (const row of source) {
      const value = numberValue(await cellText(row, cap, field));
      if (!best || (direction === 'min' ? value < best.value : value > best.value)) best = { row, value };
    }
    if (!best) throw new Error('No rows available to rank by ' + field + '.');
    this.selectedRows = [best.row];
    this.selectedCapability = cap;
  }

  private async doChooseSelected(): Promise<void> {
    bindingFor('chooseSelected', {}, this.selectedCapability);
    if (this.selectedRows.length !== 1) throw new Error('chooseSelected requires exactly one selected row; found ' + this.selectedRows.length + '.');
    await this.selectedRows[0].scrollIntoViewIfNeeded();
  }

  private async doAssertTableContains(criteria: Criteria[]): Promise<void> {
    const binding = bindingFor('assertTableContains', { criteria }, this.selectedCapability);
    const cap = binding.capability || this.selectedCapability;
    if (!cap) throw new Error('assertTableContains requires a verified entity_collection capability.');
    const matches = await this.matchingRows(cap, criteria);
    expect(matches.length, 'expected table/entity collection to contain matching row').toBeGreaterThan(0);
  }

  private async doInvokeAction(action: string): Promise<void> {
    const binding = bindingFor('invokeAction', { action });
    const selector = clean(binding.capability?.evidence?.action?.selector || binding.capability?.evidence?.button?.selector || binding.capability?.evidence?.submit?.selector);
    if (!selector) throw new Error('No verified selector for action "' + action + '".');
    const css = cssSelectorOnly(selector);
    if (css && this.selectedRows.length === 1) {
      const scoped = this.selectedRows[0].locator(css);
      if (await scoped.count().catch(() => 0)) {
        await (await uniqueVisible(scoped, 'selected-row action "' + action + '"')).click();
        return;
      }
    }
    await (await uniqueVisible(recordedLocator(this.page, selector), 'action "' + action + '"')).click();
  }

  private async doDownloadFile(target: string): Promise<void> {
    const binding = bindingFor('downloadFile', { target });
    const selector = clean(binding.capability?.evidence?.control?.selector || binding.capability?.evidence?.action?.selector || binding.capability?.evidence?.button?.selector);
    if (!selector) throw new Error('No verified download selector for "' + target + '".');
    const control = await uniqueVisible(recordedLocator(this.page, selector), 'download "' + target + '"');
    const downloadPromise = this.page.waitForEvent('download', { timeout: 15000 });
    await control.click();
    const download = await downloadPromise;
    const dir = path.join(process.cwd(), 'test-results', 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const fileName = download.suggestedFilename();
    const savePath = path.join(dir, fileName);
    await download.saveAs(savePath);
    this.downloads.push({ fileName, path: savePath });
  }

${methods}
}
`;
}

function emitPlaywrightSteps(ops) {
  const steps = ops.map((op) => tsStepFunction(registry.getStep(op))).join('\n\n');
  return `import { createBdd } from 'playwright-bdd';
import { criteriaFromDataTable, ops } from '../support/capabilityOperations';

type BddDataTable = { hashes(): Array<Record<string, string>> };

const { Given, When, Then, And } = createBdd();

${steps}
`;
}

function emitPlaywrightBddGlue({ operations, bindingMetadata } = {}) {
  const registryCheck = registry.validateStepRegistry();
  const validation = validateOperationSet(operations, 'playwright-bdd', bindingMetadata);
  const findings = [...registryCheck.findings, ...validation.findings];
  const ops = validation.ops;
  const bindings = Array.isArray(validation.operations)
    ? validation.operations.filter((op) => op && typeof op === 'object')
    : ops.map((op) => ({ operation: op, params: {} }));
  const diagnosticValid = !findings.some((f) => f.severity === 'error');
  return {
    valid: diagnosticValid,
    diagnosticValid,
    files: {
      'steps/capability.steps.ts': emitPlaywrightSteps(ops),
      'support/capabilityOperations.ts': emitPlaywrightSupport(ops, bindings),
    },
    findings,
  };
}

function javaIdent(value, fallback = 'value') {
  const safe = jsIdent(value, fallback);
  return /^[A-Za-z_$]/.test(safe) ? safe : `v${safe}`;
}

function javaStepMethod(entry) {
  const expression = cucumberExpression(entry);
  const args = nonTableArgs(entry);
  const javaArgs = args.map((arg) => `String ${javaIdent(arg)}`);
  if (entry.table === 'criteria') javaArgs.push('DataTable dataTable');
  const callArgs = args.map((arg) => javaIdent(arg));
  if (entry.table === 'criteria') callArgs.push('Criteria.fromDataTable(dataTable)');
  const method = javaIdent(entry.operation);
  return `    @${entry.keyword}(${javaString(expression)})
    public void ${method}(${javaArgs.join(', ')}) {
        ops().${entry.operation}(${callArgs.join(', ')});
    }`;
}

function javaMethod(entry) {
  const args = nonTableArgs(entry);
  const javaArgs = args.map((arg) => `String ${javaIdent(arg)}`);
  if (entry.table === 'criteria') javaArgs.push('List<Criteria> criteria');
  const putLines = args.map((arg) => `        params.put(${javaString(arg)}, ${javaIdent(arg)});`);
  if (entry.table === 'criteria') putLines.push('        params.put("criteria", criteria);');
  return `    public void ${entry.operation}(${javaArgs.join(', ')}) {
        Map<String, Object> params = new LinkedHashMap<>();
${putLines.join('\n')}
        dispatch(${javaString(entry.operation)}, params);
    }`;
}

function emitSeleniumSteps(ops) {
  const steps = ops.map((op) => javaStepMethod(registry.getStep(op))).join('\n\n');
  return `package ${BASE_PACKAGE}.steps;

import ${BASE_PACKAGE}.bdd.CapabilityOperations;
import ${BASE_PACKAGE}.bdd.Criteria;
import ${BASE_PACKAGE}.util.DriverManager;
import io.cucumber.datatable.DataTable;
import io.cucumber.java.en.And;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

public class CapabilitySteps {
    private CapabilityOperations ops() {
        return new CapabilityOperations(DriverManager.getDriver());
    }

${steps}
}
`;
}

function emitSeleniumOperations(ops) {
  const methods = ops.map((op) => javaMethod(registry.getStep(op))).join('\n\n');
  return `package ${BASE_PACKAGE}.bdd;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class CapabilityOperations {
    private static final Pattern SAFE_REF = Pattern.compile("^(env|vault|fixture|runtime|dependency|generated):(.+)$", Pattern.CASE_INSENSITIVE);

    public interface Dispatcher {
        void dispatch(WebDriver driver, String operation, Map<String, Object> params);
    }

    private static Dispatcher dispatcher = CapabilityOperations::dispatchDefault;

    private final WebDriver driver;

    public CapabilityOperations(WebDriver driver) {
        this.driver = driver;
    }

    public static void setDispatcher(Dispatcher next) {
        dispatcher = next == null ? dispatcher : next;
    }

    private void dispatch(String operation, Map<String, Object> params) {
        dispatcher.dispatch(driver, operation, resolveParams(params));
    }

    private static void dispatchDefault(WebDriver driver, String operation, Map<String, Object> params) {
        if (!operation.startsWith("authored")) {
            throw new UnsupportedOperationException("BDD operation " + operation + " is not bound to a ReplayIR/capability helper.");
        }
        String target = String.valueOf(params.getOrDefault("target", "semantic page control"));
        String value = String.valueOf(params.getOrDefault("value", "no authored value"));
        String details = decodeDetails(String.valueOf(params.getOrDefault("details", "")));
        String action = jsonField(details, "action").toLowerCase();
        boolean soft = details.contains("\\\"soft\\\":true") || details.contains("\\\"optional\\\":true");
        try {
            if (operation.equals("authoredContext") || operation.equals("authoredDependency")) return;
            if ((action.contains("navigate") || action.contains("open") || action.contains("visit"))
                    && details.contains("\\\"authoredNavigation\\\":true")) {
                driver.get(value);
                return;
            }
            WebElement element = authoredElement(driver, target, details);
            if (operation.equals("authoredWait")) return;
            if (operation.equals("authoredAssertion")) {
                if (!value.equals("no authored value") && !element.getText().toLowerCase().contains(value.toLowerCase())) {
                    throw new AssertionError("Authored expectation did not match " + target);
                }
                return;
            }
            if (action.matches(".*(fill|type|enter|input).*")) { element.clear(); element.sendKeys(value); return; }
            if (action.contains("check") && !element.isSelected()) { element.click(); return; }
            element.click();
        } catch (RuntimeException | AssertionError error) {
            if (!soft) throw error;
            System.err.println("QAAI non-blocking authored step mismatch: " + error.getMessage());
        }
    }

    private static WebElement authoredElement(WebDriver driver, String target, String details) {
        String selector = jsonField(details, "selector");
        if (!selector.isBlank() && !selector.startsWith("getBy")) {
            List<WebElement> exact = driver.findElements(By.cssSelector(selector));
            if (exact.size() == 1) return exact.get(0);
        }
        String safe = target.replace("\\\"", "");
        String xpath = "//*[@aria-label=\\\"" + safe + "\\\" or @placeholder=\\\"" + safe + "\\\" or normalize-space()=\\\"" + safe + "\\\"]";
        List<WebElement> semantic = driver.findElements(By.xpath(xpath));
        if (semantic.size() != 1) throw new IllegalStateException("Authored target '" + target + "' resolved to " + semantic.size() + " elements.");
        return semantic.get(0);
    }

    private static String decodeDetails(String encoded) {
        try { return new String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8); }
        catch (IllegalArgumentException ignored) { return "{}"; }
    }

    private static String jsonField(String json, String name) {
        Matcher matcher = Pattern.compile("\\\"" + Pattern.quote(name) + "\\\"\\\\s*:\\\\s*\\\"([^\\\"]*)\\\"").matcher(json == null ? "" : json);
        return matcher.find() ? unescapeJsonString(matcher.group(1)) : "";
    }

    private static String unescapeJsonString(String value) {
        return value.replace(
            String.valueOf((char) 92) + String.valueOf((char) 34),
            String.valueOf((char) 34)
        );
    }

    private static Map<String, Object> resolveParams(Map<String, Object> params) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : params.entrySet()) {
            out.put(entry.getKey(), resolveSafeRefs(entry.getValue()));
        }
        return out;
    }

    private static Object resolveSafeRefs(Object value) {
        if (value instanceof String text) return resolveString(text);
        if (value instanceof Criteria c) return new Criteria(c.field(), c.operator(), resolveString(c.value()));
        if (value instanceof List<?> list) return list.stream().map(CapabilityOperations::resolveSafeRefs).toList();
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                out.put(String.valueOf(entry.getKey()), resolveSafeRefs(entry.getValue()));
            }
            return out;
        }
        return value;
    }

    private static String resolveString(String value) {
        Matcher matcher = SAFE_REF.matcher(value == null ? "" : value);
        if (!matcher.matches()) return value;
        String kind = matcher.group(1).toLowerCase();
        String body = matcher.group(2);
        String envName = kind.equals("env") ? body : envNameFromRef(kind, body);
        String resolved = System.getenv(envName);
        if (resolved == null || resolved.isBlank()) {
            throw new IllegalStateException("Missing required environment variable " + envName);
        }
        return resolved;
    }

    private static String envNameFromRef(String kind, String body) {
        String suffix = (body == null ? "" : body)
            .toUpperCase()
            .replaceAll("[^A-Z0-9]+", "_")
            .replaceAll("^_+|_+$", "");
        if (suffix.isBlank()) suffix = "VALUE";
        if (kind.equals("fixture")) return "QAAI_FIXTURE_" + suffix;
        if (kind.equals("vault")) return "QAAI_VAULT_" + suffix;
        if (kind.equals("runtime")) return "QAAI_RUNTIME_" + suffix;
        if (kind.equals("dependency")) return "QAAI_DEPENDENCY_" + suffix;
        if (kind.equals("generated")) return "QAAI_GENERATED_" + suffix;
        return suffix;
    }

${methods}
}
`;
}

function emitSeleniumCriteria() {
  const operators = [...registry.CRITERIA_OPERATORS].map(javaString).join(', ');
  return `package ${BASE_PACKAGE}.bdd;

import io.cucumber.datatable.DataTable;

import java.util.List;
import java.util.Map;
import java.util.Set;

public record Criteria(String field, String operator, String value) {
    private static final Set<String> ALLOWED_OPERATORS = Set.of(${operators});

    public static List<Criteria> fromDataTable(DataTable table) {
        return table.asMaps(String.class, String.class).stream()
            .map(Criteria::fromRow)
            .toList();
    }

    private static Criteria fromRow(Map<String, String> row) {
        String field = value(row, "field");
        String operator = value(row, "operator");
        String value = value(row, "value");
        if (field.isBlank()) throw new IllegalArgumentException("Criteria row is missing field.");
        if (!ALLOWED_OPERATORS.contains(operator)) throw new IllegalArgumentException("Unsupported criteria operator: " + operator);
        if (value.isBlank()) throw new IllegalArgumentException("Criteria row is missing value.");
        return new Criteria(field, operator, value);
    }

    private static String value(Map<String, String> row, String key) {
        String value = row.get(key);
        return value == null ? "" : value.trim();
    }
}
`;
}

function emitSeleniumBddGlue({ operations, bindingMetadata } = {}) {
  const registryCheck = registry.validateStepRegistry();
  const validation = validateOperationSet(operations, 'selenium-bdd', bindingMetadata);
  const findings = [...registryCheck.findings, ...validation.findings];
  const ops = validation.ops;
  const diagnosticValid = !findings.some((f) => f.severity === 'error');
  return {
    valid: diagnosticValid,
    diagnosticValid,
    files: {
      [`src/test/java/${PKG_PATH}/steps/CapabilitySteps.java`]: emitSeleniumSteps(ops),
      [`src/main/java/${PKG_PATH}/bdd/CapabilityOperations.java`]: emitSeleniumOperations(ops),
      [`src/main/java/${PKG_PATH}/bdd/Criteria.java`]: emitSeleniumCriteria(),
    },
    findings,
  };
}

module.exports = {
  emitPlaywrightBddGlue,
  emitSeleniumBddGlue,
  cucumberExpression,
  finding,
};
