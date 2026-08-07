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
  createControllerCompositeExecutor,
} = require('../server/services/controllerCompositeExecutor');
const {
  createBrowserTransactionController,
} = require('../server/services/browserTransactionController');

async function main() {
  const operation = compileOperationContractV2({
    id: 'composite-case',
    steps: [{
      id: 'equipment',
      type: 'Select',
      target: 'Equipment dropdown',
      value: 'Dry Van',
      selectionCriteria: { kind: 'predicate', predicate: 'contains Dry' },
    }],
  }).actions[0];
  const dispatches = [];
  const authority = createControllerAuthority();
  const gateway = createControllerActionExecutionGateway({
    transport: async ({ toolName, args }) => {
      dispatches.push({ toolName, args });
      return { delivered: true };
    },
  });
  let ownerValue = null;
  const observer = async ({ plan, phase }) => {
    const phaseId = plan?.protocolPhase?.phaseId || phase;
    const claim = (claimId) => ({
      claimId,
      status: 'MATCHED',
      tier: 500,
      source: 'deterministic-verifier',
      factRef: `fact:${phaseId}:${claimId}`,
    });
    if (phaseId === 'pre_dispatch') return { claims: [] };
    if (phaseId === 'owner-ready') return { claims: [claim('same_owner_actionable')] };
    if (phaseId === 'popup-associated') return { claims: [claim('associated_popup_open')] };
    if (phaseId === 'option-resolved') {
      return {
        claims: [claim('exact_option_candidate')],
        candidates: [{
          ref: 'e-option',
          accessibleName: 'Dry Van',
          ownerRef: 'e-owner',
          actionable: true,
        }],
      };
    }
    if (phaseId === 'owner-readback') {
      ownerValue = 'Dry Van';
      return { claims: [claim('owner_state_committed')] };
    }
    return { claims: [] };
  };
  const compositeExecutor = createControllerCompositeExecutor({ observer, gateway });
  const controller = createBrowserTransactionController({
    controllerAuthority: authority,
    resolver: async () => ({
      status: 'RESOLVED',
      target: { ref: 'e-owner', identity: operation.targetIdentity },
      factRefs: ['fact:owner'],
    }),
    planner: createTypedAdapterPlan,
    observer,
    gateway,
    compositeExecutor,
    defaultDeadlineMs: 2_000,
  });
  const result = await controller.execute(operation);
  if (result.terminalDecision?.state !== 'COMMITTED') {
    throw new Error(`Expected COMMITTED, received ${JSON.stringify({
      terminalDecision: result.terminalDecision,
      snapshot: result.snapshot,
      dispatches,
    })}`);
  }
  if (dispatches.length !== 1
    || dispatches[0].toolName !== 'browser_evaluate'
    || dispatches[0].args.target !== 'e-owner'
    || !String(dispatches[0].args.function || '').includes('virtualized_selection_semantic_ambiguous')
    || ownerValue !== 'Dry Van') {
    throw new Error(`Composite dispatch mismatch: ${JSON.stringify({ dispatches, ownerValue })}`);
  }
  process.stdout.write('PASS dropdown scans and selects its owned virtualized option in one mutation, then commits owner readback\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
