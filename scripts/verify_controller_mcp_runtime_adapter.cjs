'use strict';

const {
  compileOperationContractV2,
} = require('../server/services/operationContractV2');
const {
  createControllerAuthority,
} = require('../server/services/browserTransactionAuthority');
const {
  createControllerActionExecutionGateway,
} = require('../server/services/controllerActionExecutionGateway');
const {
  createTypedAdapterPlan,
} = require('../server/services/controllerTypedAdapterRegistry');
const {
  createBrowserTransactionController,
} = require('../server/services/browserTransactionController');
const {
  createControllerMcpRuntimeAdapter,
} = require('../server/services/controllerMcpRuntimeAdapter');

async function main() {
  const calls = [];
  const session = {
    id: 'fake-controller-session',
    authorityMode: 'browser_transaction_controller',
    closed: false,
    mcpTools: [],
    client: {
      callTool: async ({ name, arguments: args }) => {
        calls.push({ name, args });
        if (name === 'browser_evaluate') {
          const exactOwnerReadback = String(args?.function || '')
            .includes('text_input_owner_value_committed');
          return {
            isError: false,
            content: [{
              type: 'text',
              text: [
                '### Result',
                exactOwnerReadback
                  ? '"{\\"ok\\":true,\\"reason\\":\\"text_input_owner_value_committed\\",\\"candidateCount\\":1,\\"matched\\":true,\\"ownerStateCommitted\\":true,\\"stableAcrossSettle\\":true,\\"ownerConnected\\":true,\\"matchMode\\":\\"exact\\",\\"role\\":\\"textbox\\",\\"valuePresent\\":true,\\"valueLength\\":15,\\"digitCount\\":0,\\"disabled\\":false,\\"readOnly\\":false,\\"invalid\\":false}"'
                  : '"{\\"ok\\":true,\\"reason\\":\\"bound_text_input_owner_revealed_and_focused\\",\\"candidateCount\\":1,\\"connected\\":true,\\"visible\\":true,\\"focused\\":true,\\"actionable\\":true}"',
              ].join('\n'),
            }],
          };
        }
        return {
          isError: false,
          content: [{
            type: 'text',
            text: [
              '### Page state',
              '- Page URL: https://example.test/email',
              '- Page Title: Email',
              '- Page Snapshot:',
              '  - textbox "Email Address" [ref=e1]',
              '  - button "Continue" [ref=e2]',
            ].join('\n'),
          }],
        };
      },
    },
  };
  const operation = compileOperationContractV2({
    id: 'email-case',
    steps: [{
      id: 'email',
      type: 'Fill',
      target: 'Email Address field',
      value: 'qa@example.test',
    }],
  }).actions[0];
  const adapter = createControllerMcpRuntimeAdapter({
    session,
    operations: [operation],
  });
  const authority = createControllerAuthority();
  const gateway = createControllerActionExecutionGateway({ transport: adapter.transport });
  const controller = createBrowserTransactionController({
    controllerAuthority: authority,
    resolver: adapter.resolver,
    planner: createTypedAdapterPlan,
    observer: adapter.observer,
    gateway,
    defaultDeadlineMs: 3_000,
  });
  const result = await controller.execute(operation, { session });
  const exactOwnerReadbacks = calls.filter((call) => (
    call.name === 'browser_evaluate'
      && String(call.args?.function || '').includes('text_input_owner_value_committed')
  ));
  const mutations = calls.filter((call) => (
    call.name === 'browser_type'
      || (call.name === 'browser_evaluate'
        && String(call.args?.function || '').includes('bound_text_input_owner_revealed_and_focused'))
  ));
  if (result.terminalDecision?.state !== 'COMMITTED') {
    throw new Error(JSON.stringify(result.terminalDecision));
  }
  if (mutations.length !== 2
    || mutations[0].name !== 'browser_evaluate'
    || !String(mutations[0].args.function || '').includes('bound_text_input_owner_revealed_and_focused')
    || mutations[1].name !== 'browser_type'
    || mutations[1].args.target !== 'e1'
    || mutations[1].args.text !== 'qa@example.test'
    || exactOwnerReadbacks.length !== 1) {
    throw new Error(`Expected one exact reveal, one exact browser_type mutation, and one owner readback: ${JSON.stringify(calls)}`);
  }
  process.stdout.write('PASS controller MCP adapter reveals the exact owner, fills once, and commits from exact same-owner readback\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
