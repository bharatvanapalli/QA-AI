'use strict';

const assert = require('node:assert/strict');
const { createControllerAuthority } = require('../server/services/browserTransactionAuthority');
const {
  DELIVERY_STATUS,
  createInMemoryDispatchJournal,
  createControllerActionExecutionGateway,
} = require('../server/services/controllerActionExecutionGateway');
const {
  OPERATION_CLASS,
  classifyControllerBrowserTool,
} = require('../server/services/controllerBrowserMutationTaxonomy');

let passed = 0;

async function verify(name, check) {
  await check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function request(authority) {
  return {
    authority,
    operation: {
      operationId: 'action:login:email',
      actionOccurrenceId: 'occurrence:action:login:email:1',
    },
    plan: {
      mutation: {
        toolName: 'browser_fill',
        args: { target: 'e1', text: 'qa@example.test' },
      },
    },
  };
}

(async () => {
  await verify('gateway persists intent then dispatches exactly once', async () => {
    const journal = createInMemoryDispatchJournal();
    let calls = 0;
    const gateway = createControllerActionExecutionGateway({
      journal,
      transport: async () => {
        calls += 1;
        return { delivered: true };
      },
    });
    const result = await gateway.dispatch(request(createControllerAuthority()));
    assert.equal(calls, 1);
    assert.equal(result.deliveryStatus, DELIVERY_STATUS.DELIVERED);
    assert.deepEqual(journal.allEvents().map((event) => event.eventType), [
      'DISPATCH_INTENT_PERSISTED',
      'DISPATCH_STARTED',
      'DELIVERY_RECORDED',
    ]);
    assert.equal(Object.hasOwn(journal.allEvents()[0], 'args'), false);
  });

  await verify('same occurrence can never dispatch twice', async () => {
    const gateway = createControllerActionExecutionGateway({
      transport: async () => ({ delivered: false, positivelyNotDelivered: true }),
    });
    const authority = createControllerAuthority();
    const input = request(authority);
    await gateway.dispatch(input);
    await assert.rejects(
      () => gateway.dispatch(input),
      (error) => error?.code === 'CONTROLLER_GATEWAY_DUPLICATE_OCCURRENCE',
    );
  });

  await verify('gateway has no target proof continuation commit or verdict authority', async () => {
    const gateway = createControllerActionExecutionGateway({
      transport: async () => ({ delivered: true }),
    });
    assert.deepEqual(Object.keys(gateway).sort(), [
      'consumeTransportPermit',
      'dispatch',
      'gatewayVersion',
    ]);
  });

  await verify('executable code and non-allowlisted CDP are mutation-authorized', async () => {
    assert.equal(
      classifyControllerBrowserTool('browser_evaluate', {
        function: '() => document.title',
      }).operationClass,
      OPERATION_CLASS.MUTATION,
    );
    assert.equal(
      classifyControllerBrowserTool('browser_execute_cdp_command', {
        command: 'Network.setCookies',
      }).operationClass,
      OPERATION_CLASS.MUTATION,
    );
    assert.equal(
      classifyControllerBrowserTool('browser_execute_cdp_command', {
        command: 'DOM.describeNode',
      }).operationClass,
      OPERATION_CLASS.OBSERVATION,
    );
  });

  process.stdout.write(`OK ${passed} minimal gateway invariants\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
