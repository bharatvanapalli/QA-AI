#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const evidenceRepair = require(path.join(root, 'server/services/agents/evidenceRepair'));
const actionLocatorResolver = require(path.join(root, 'server/services/actionLocatorResolver'));
const replayContract = require(path.join(root, 'server/services/codegen/_replayContract'));

console.log('[evidence-repair] verifying action-time repair contract');

assert.strictEqual(
  evidenceRepair.expressionFromCandidate({ role: 'button', accessibleName: '' }),
  null,
  'role-only repair candidates must not emit bare getByRole("button") locators'
);

const gap = {
  type: 'missing_verified_action_locator',
  pageUrl: 'https://example.test/products',
  narration: 'Search submit button',
  action: { tool: 'browser_click', narration: 'Search submit button' },
};
const winner = {
  role: 'button',
  accessibleName: 'Search',
  ref: 'e42',
  line: 'button "Search" [ref=e42]',
};
const expression = evidenceRepair.expressionFromCandidate(winner);
const actionLocator = evidenceRepair.buildActionLocatorCandidateFromRepair({
  gap,
  winner,
  expression,
  pageUrl: gap.pageUrl,
  narration: gap.narration,
});

assert(!actionLocatorResolver.isVerifiedActionLocator(actionLocator), 'snapshot repair must not impersonate a verified ActionLocator');
assert(actionLocatorResolver.isExportSafeActionLocator(actionLocator), 'snapshot repair remains an explicitly annotated last-resort candidate');
assert.strictEqual(actionLocator.verificationSource, 'snapshot_ref_fallback');
assert.strictEqual(actionLocator.proof.count, null);
assert.strictEqual(actionLocator.proof.sameElement, false);
assert.strictEqual(actionLocator.proof.actionTimeResolved, false);
assert.strictEqual(actionLocator.guess.isGuess, true);
assert.strictEqual(actionLocator.domAtlas.verifiedActions.length, 0, 'snapshot repair must not enter DOM Atlas verifiedActions');

const journeyCases = [{
  actionPlan: {
    actions: [{
      tool: 'browser_click',
      narration: 'Search submit button',
      pageUrl: gap.pageUrl,
      kbMiss: true,
    }],
  },
}];

evidenceRepair.applyRepairResults({
  journeyCases,
  resolved: [{
    action: gap.action,
    locator: {
      expression,
      source: 'qaaiGuessedLocator',
      verified: false,
      verificationSource: actionLocator.verificationSource,
      actionLocator,
    },
  }],
});

const repairedAction = journeyCases[0].actionPlan.actions[0];
assert(repairedAction.kbMiss, 'applyRepairResults preserves kbMiss for snapshot-only repair');
assert(repairedAction.guessedLocator, 'applyRepairResults marks the action as guessed');
assert(repairedAction.locator && repairedAction.locator.source === 'qaaiGuessedLocator', 'applyRepairResults stores an explicit guessed locator source');
assert(!actionLocatorResolver.isVerifiedActionLocator(repairedAction.actionLocator), 'applyRepairResults never promotes snapshot-only evidence to verified');

const contract = replayContract.validateContract({
  actions: [{
    disposition: 'committed',
    tool: 'browser_click',
    pageUrl: gap.pageUrl,
    narration: 'Search submit button',
    locator: { expression },
  }],
  declaredAssertions: [],
  authInfo: { preAuthenticated: true },
  credProfile: { missing: [] },
  replayIrItems: [],
});

assert.strictEqual(contract.verdict, 'exportable', 'missing actionLocator is advisory when the complete action can still be emitted');
assert(contract.warningGaps.some((item) => item.type === 'missing_verified_action_locator' && item.nonBlocking === true), 'contract exposes missing verified action locator as a non-blocking warning');
assert(replayContract.isRepairableGap('missing_action_locator_evidence'), 'emitter missing-action-locator gaps are repairable');

const guessed = replayContract.withGuessedLocatorMetadata({
  disposition: 'committed',
  tool: 'browser_click',
  narration: 'Search submit button',
  args: { element: 'Search submit button', role: 'button' },
  kbMiss: true,
});
assert.strictEqual(guessed.guessedLocator, true, 'kbMiss actions receive explicit guessed locator metadata');
assert.strictEqual(guessed.locator.source, 'qaaiGuessedLocator', 'guessed locator source remains visible to codegen');
assert(guessed.locator.warning.includes('Replace it with a reliable DOM locator'), 'guessed locator carries the user-facing replacement warning');

console.log('[evidence-repair] ok');
