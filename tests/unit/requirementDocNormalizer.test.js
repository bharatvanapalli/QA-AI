import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  deterministicNormalize,
  stripModalHelpers,
  isAlreadyCanonical,
} = require('../../server/services/requirementDocNormalizer');
const caseContractV1 = require('../../server/services/caseContractV1');

describe('requirementDocNormalizer', () => {
  it('strips modal helper verbs from assertion phrases', () => {
    const input = 'The submit button should be disabled and the error message must be visible';
    const output = stripModalHelpers(input);
    expect(output).toBe('The submit button is disabled and the error message is visible');
  });

  it('detects if text is already canonical colon-format', () => {
    const canonical = `
Requirement Title: Order Flow
Steps:
1. Navigate to "https://example.com"
Final Validation:
- Success message is displayed
`;
    expect(isAlreadyCanonical(canonical)).toBe(true);

    const markdownStyle = `
# User Story: Order Flow
### Steps
1. Navigate to "https://example.com"
### Validations & Acceptance Criteria
- Verify that "Toast" displays "Created" [Must]
`;
    expect(isAlreadyCanonical(markdownStyle)).toBe(false);
  });

  it('normalizes markdown ATX headings and [Must] tags into canonical caseContractV1 format', () => {
    const rawUserStory = `
# User Story: Create Inbound Freight Order
Module: Orders
Priority: P0

## Session & Dependency
Execution Mode: Fresh Session

## Test Data
| Dataset | Customer Name | Ship Direction | Freight Term | Password |
| :--- | :--- | :--- | :--- | :--- |
| Primary | ACME Logistics | Inbound | COL | secret123 |
| Secondary | Global Freight | Outbound | PPD | secret456 |

---

## Scenario 1: Successful Inbound Order Creation
Type: Functional

### Steps
1. Navigate to "https://app.example.com/orders/new"
   - Verify that "Order Entry Form" is visible.
2. Fill "Customer Name" with "{{Customer Name}}"
   - Verify that "Customer Name field" contains "{{Customer Name}}".
3. Select "{{Ship Direction}}" from "Ship Direction dropdown"
   - Verify that "Ship Direction field" displays "{{Ship Direction}}".
4. Click "Save Order button"

### Validations & Acceptance Criteria
- Verify that "Confirmation Toast" displays text "Order Successfully Created" [Must]
- Verify that "Order Status field" displays "Created" [Must]
`;

    const normalized = deterministicNormalize(rawUserStory);

    // Verify canonical section headers were created
    expect(normalized).toContain('Requirement Title: Create Inbound Freight Order');
    expect(normalized).toContain('Scenario: Successful Inbound Order Creation');
    expect(normalized).toContain('Steps:');
    expect(normalized).toContain('Test Data:');
    expect(normalized).toContain('Final Validation:');
    expect(normalized).not.toContain('[Must]');

    // Round-trip test: compile directly through UNMODIFIED caseContractV1
    const compiled = caseContractV1.compileCaseContractV1([
      { title: 'Normalized User Story', content: normalized },
    ]);

    expect(compiled).toBeDefined();
    expect(compiled.cases.length).toBeGreaterThanOrEqual(1);

    const testCase = compiled.cases[0];
    expect(testCase.name).toBe('Create Inbound Freight Order');

    // Verify compiled steps exist
    expect(testCase.steps.length).toBeGreaterThan(0);

    // Verify navigation action
    const navStep = testCase.steps.find((s) => s.action === 'Navigate' || s.type === 'Navigate');
    expect(navStep).toBeDefined();

    // Verify fill action with token
    const fillStep = testCase.steps.find((s) => s.action === 'Fill' || s.type === 'Fill');
    expect(fillStep).toBeDefined();

    // Verify test data rows were extracted
    expect(compiled.dataRows.length).toBe(2);
    expect(compiled.dataRows[0].bindings.customer_name).toBeDefined();
  });
});
