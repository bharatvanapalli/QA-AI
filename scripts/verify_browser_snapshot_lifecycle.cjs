'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SNAPSHOT_STATUS,
  SNAPSHOT_SOURCE,
  createBrowserSnapshotLifecycle,
} = require('../server/services/browserSnapshotLifecycle');

let passed = 0;

async function verify(name, check) {
  await check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

(async () => {
  await verify('transient white snapshot recaptures observation and then succeeds', async () => {
    let calls = 0;
    const lifecycle = createBrowserSnapshotLifecycle({
      now: () => 100,
      sleep: async () => {},
      capture: async () => {
        calls += 1;
        return calls === 1 ? {
          browserEpoch: 'epoch:1',
          capturedAtMs: 100,
          sources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
          snapshotText: '',
          domNodeCount: 0,
          screenshotUniformWhite: true,
        } : {
          browserEpoch: 'epoch:1',
          capturedAtMs: 100,
          sources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
          snapshotText: 'textbox "Email address"',
          domNodeCount: 2,
        };
      },
    });
    const result = await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    assert.equal(calls, 2);
    assert.equal(result.status, SNAPSHOT_STATUS.VALID);
  });

  await verify('same-epoch valid snapshot uses the fast cache path', async () => {
    let calls = 0;
    const lifecycle = createBrowserSnapshotLifecycle({
      now: () => 100,
      capture: async () => {
        calls += 1;
        return {
          browserEpoch: 'epoch:1',
          capturedAtMs: 100,
          sources: [SNAPSHOT_SOURCE.DOM],
          snapshotText: 'button "Sign in"',
          domNodeCount: 1,
        };
      },
    });
    await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    const cached = await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    assert.equal(calls, 1);
    assert.equal(cached.cacheHit, true);
  });

  await verify('snapshot lifecycle has no mutation or verdict authority', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'browserSnapshotLifecycle.js'),
      'utf8',
    );
    assert.equal(/\bbrowser_(?:click|fill|type|select|press_key|evaluate)\b/.test(source), false);
    assert.equal(/\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
  });

  process.stdout.write(`OK ${passed} snapshot lifecycle invariants\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
