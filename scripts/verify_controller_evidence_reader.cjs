'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SOURCE_STATUS,
  SNAPSHOT_SOURCE,
  createControllerEvidenceReader,
} = require('../server/services/controllerEvidenceReader');

let passed = 0;

async function verify(name, check) {
  await check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

(async () => {
  await verify('independent evidence sources start in parallel', async () => {
    const started = [];
    let releaseDom;
    let releaseAx;
    const reader = createControllerEvidenceReader({
      readers: {
        [SNAPSHOT_SOURCE.DOM]: async () => {
          started.push('dom');
          await new Promise((resolve) => { releaseDom = resolve; });
          return { factRef: 'dom:1' };
        },
        [SNAPSHOT_SOURCE.ACCESSIBILITY]: async () => {
          started.push('ax');
          await new Promise((resolve) => { releaseAx = resolve; });
          return { factRef: 'ax:1' };
        },
      },
    });
    const pending = reader.capture({
      requiredSources: [SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY],
      remainingMs: 1_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(started.sort(), ['ax', 'dom']);
    releaseDom();
    releaseAx();
    const result = await pending;
    assert.deepEqual(result.factRefs, ['dom:1', 'ax:1']);
  });

  await verify('stalled event reader is bounded while exact DOM facts survive', async () => {
    const reader = createControllerEvidenceReader({
      perSourceDeadlineMs: 20,
      readers: {
        [SNAPSHOT_SOURCE.DOM]: async () => ({
          claims: [{ claimId: 'email_value', status: 'MATCHED', tier: 500 }],
          factRef: 'dom:email',
        }),
        [SNAPSHOT_SOURCE.EVENT]: async () => new Promise(() => {}),
      },
    });
    const result = await reader.capture({
      requiredSources: [SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.EVENT],
      remainingMs: 100,
    });
    assert.equal(result.claims.length, 1);
    assert.equal(result.factRefs.includes('dom:email'), true);
    assert.equal(
      result.observations.find((item) => item.source === SNAPSHOT_SOURCE.EVENT).status,
      SOURCE_STATUS.UNAVAILABLE,
    );
  });

  await verify('evidence reader is concurrent and owns no mutation or verdict', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'controllerEvidenceReader.js'),
      'utf8',
    );
    assert.equal(source.includes('Promise.all('), true);
    assert.equal(/\bdispatch\s*\(|\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
  });

  process.stdout.write(`OK ${passed} bounded evidence reader invariants\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
