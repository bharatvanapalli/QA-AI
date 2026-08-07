'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const resolver = require('../server/services/controllerSemanticResolver');

let passed = 0;

function verify(name, check) {
  check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

verify('resolver disambiguates repeated labels by authored section', () => {
  const result = resolver.resolveSemanticTarget({
    targetIdentity: { accessibleName: 'Date', role: 'textbox', section: 'Pickup' },
    candidates: [{
      source: 'dom',
      identity: { accessibleName: 'Date', role: 'textbox', section: 'Pickup', backendNodeId: 1 },
      connected: true,
    }, {
      source: 'dom',
      identity: { accessibleName: 'Date', role: 'textbox', section: 'Delivery', backendNodeId: 2 },
      connected: true,
    }],
  });
  assert.equal(result.status, resolver.RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.target.identity.backendNodeId, '1');
});

verify('resolver deduplicates cross-source facts by backend node', () => {
  const identity = { accessibleName: 'Email address', role: 'textbox', backendNodeId: 42 };
  const result = resolver.resolveSemanticTarget({
    targetIdentity: { accessibleName: 'Email address', role: 'textbox' },
    candidates: [{
      source: 'dom', identity, connected: true, factRef: 'dom:42',
    }, {
      source: 'ax', identity, connected: true, actionable: true, factRef: 'ax:42',
    }],
  });
  assert.equal(result.status, resolver.RESOLUTION_STATUS.RESOLVED);
  assert.deepEqual(result.target.sources, ['dom', 'ax']);
});

verify('resolver returns facts only and contains no browser mutation dependency', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'controllerSemanticResolver.js'),
    'utf8',
  );
  assert.equal(source.includes("require('./actionExecutionGateway"), false);
  assert.equal(source.includes("require('./mcp"), false);
  assert.equal(/\bbrowser_(?:click|fill|type|select|press_key|evaluate)\b/.test(source), false);
  assert.equal(/\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
});

process.stdout.write(`OK ${passed} pure semantic resolver invariants\n`);
