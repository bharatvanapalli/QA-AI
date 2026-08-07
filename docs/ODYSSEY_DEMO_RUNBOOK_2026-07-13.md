# Odyssey live-demo runbook — 2026-07-13

This is a website-neutral reliability rehearsal. Odyssey is the configured target,
but no Odyssey URL, label, selector, authentication rule, or recovery branch is
compiled into the runtime.

## Locked project baseline

- Project ID: `f8168938-ac0a-42fe-9c30-2f820aaee9dd`
- Project name: `Odyssey`
- Configured provider: `claude`
- Configured output framework before the slice: `playwright-js`
- Selected generation: `9d952135-19af-4626-ae83-696c0796588e` (version 5)
- Latest completed baseline run: `e524f110-b000-4636-9c2d-83d78c5a7ddc`
- Credentials are configured. This document intentionally contains no credential
  values and no credential-profile payload.

The baseline generation contains 8 scenarios and 10 cases. The sampled login case
reported 11/11 legacy passes but had no independent action or continuation outcomes,
and its execution graph was not exportable. The sampled continuation case reported
5 passed, 1 failed, and 20 blocked legacy rows, also without independent action or
continuation outcomes. These are the before-state defects this slice addresses; they
are not post-change proof.

## Live flow

1. Upload one of the plain-text flows under
   `tests/fixtures/july13-rehearsal/`, or an audience-provided equivalent.
2. Generate a fresh scenario set. Record its generation ID.
3. Review the generated CaseContract, data bindings, unused values, sensitive
   environment references, and explicit fresh/continuation session plan.
4. Approve cases from that generation.
5. Execute with the same explicit generation ID. A mixed or omitted generation ID
   must be rejected.
6. Follow the live step journal. For every step show action, assertion, continuation,
   dependencies, before/after page fingerprints, wait/postcondition, and evidence.
7. In Reports, confirm planned/executed/passed/validation-failed/execution-error/
   dependency-skipped counts all derive from the same journal rows.
8. Generate the Playwright POM JavaScript and TypeScript packages from the same
   ExecutedCaseAST. Confirm the immutable bundle ID and file hashes.
9. Run JavaScript live. Type-check and list TypeScript tests. Product failures stay
   enabled and fail with the journaled hard expectation.

## Required rehearsals

| Flow | Required proof |
| --- | --- |
| `identity-email-twice.txt` | The email binding is resolved against both live email prompts. Sequence position never turns the second prompt into a password field. |
| `nonblocking-validations.txt` | Text/number mismatches are recorded, independent later checks execute, and the report says `Execution completed`. |
| `product-gap.txt` | Missing product behavior is a product failure with browser evidence and an enabled failing reproduction; it is never relabeled as a QAAI execution error. |

## Verification commands

Run from the repository root:

```powershell
npx vitest run tests/unit/caseContractV1.test.js tests/unit/caseInstanceV1.test.js tests/unit/executionJournal.test.js tests/unit/pageFingerprint.test.js tests/unit/waitContract.test.js tests/unit/inPageEventRecorder.test.js tests/unit/executedCaseAst.test.js
npx vitest run tests/unit/proceduralRequirementFlow.test.js tests/unit/generationRouteInvariant.test.js tests/unit/conductorContinuity.test.js tests/unit/conductorContract.test.js tests/unit/codegenExport.test.js
node scripts/verify_codegen_contract.cjs
npm run build
```

For each generated package, also retain the literal output from its generated
validation commands (`playwright test --list`, JavaScript execution, and TypeScript
type-check/list). A command that did not run is recorded as unverified, never inferred
from source shape.

## Stop conditions

- A required target or input that QAAI cannot resolve is a QAAI execution error.
- An observed application mismatch is a product validation failure.
- A required action failure stops dependent descendants, not independent checks.
- No missing journal row may be synthesized as passed.
- No generated main-tree test may be skipped or commented out to make a bundle green.
- No bundle is exposed before locator, method, wait, enabled-test, and secret checks pass.

After three successful rehearsals, freeze architecture changes. Preserve the exact
project configuration and one prior successful run only as recovery evidence.
