'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');

const ROOT = path.resolve(__dirname, '..');
const browserMutationTaxonomy = require(path.join(ROOT, 'server/services/browserMutationTaxonomy.js'));
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
const runtimeFiles = [
  'server/services/actionExecutionGateway.js',
  'server/services/browserMutationTaxonomy.js',
  'server/services/browserActionRegistry.js',
  'server/services/actionTransactionCoordinator.js',
  'server/services/actionTransactionRepository.js',
  'server/services/mcp.js',
  'server/services/actionLocatorResolver.js',
  'server/services/agents/calibrator.js',
  'server/services/agents/evidenceRepair.js',
  'server/services/agents/healer.js',
  'server/services/runtimeHealingPolicy.js',
  'server/services/projectActionMemory.js',
  'server/services/precisionActionKernel.js',
  'server/services/executionContinuationPolicy.js',
  'server/services/executionJournal.js',
  'server/services/genericClickExecution.js',
  'server/services/universalActionKernel.js',
  'server/services/conductorUniversalRuntime.js',
  'server/services/semanticTargetReveal.js',
  'server/services/widgetExecutionKernel.js',
  'server/services/controlActionAdapter.js',
  'server/services/controlAdapterRegistry.js',
  'server/services/universalControlModel.js',
  'server/services/browserEvidenceAdapter.js',
  'server/services/browserEvidenceAdapterRegistry.js',
  'server/services/reliability/selfHealingPipeline.js',
  'server/services/evidenceReplayIr.js',
];

const sources = new Map(runtimeFiles.map((file) => [file, read(file)]));
const conductorSource = read('server/services/agents/conductor.js');
sources.set('server/services/agents/conductor.js#reviewed-static-runtime', conductorSource);

let assertions = 0;
function pass(message) {
  assertions += 1;
  console.log(`PASS ${message}`);
}
function assert(condition, message, details = '') {
  if (!condition) {
    console.error(`FAIL ${message}${details ? `\n${details}` : ''}`);
    process.exitCode = 1;
    return;
  }
  pass(message);
}
function count(source, token) {
  return source.split(token).length - 1;
}
function parse(file, source) {
  return parser.parse(source, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['optionalChaining', 'classProperties', 'objectRestSpread', 'topLevelAwait'],
  });
}
function walk(node, ancestors, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, ancestors);
  const next = typeof node.type === 'string' ? [...ancestors, node] : ancestors;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'errors', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, next, visit));
    else if (value && typeof value === 'object') walk(value, next, visit);
  }
}
function propertyName(member) {
  if (!member || !['MemberExpression', 'OptionalMemberExpression'].includes(member.type)) return null;
  if (!member.computed && member.property?.type === 'Identifier') return member.property.name;
  if (member.computed && ['StringLiteral', 'Literal'].includes(member.property?.type)) return String(member.property.value);
  return null;
}
function location(file, node) {
  return `${file}:${node.loc?.start?.line || '?'}:${node.loc?.start?.column || 0}`;
}
function insideGatewayDispatch(ancestors) {
  return ancestors.some((ancestor) => {
    if (!['CallExpression', 'OptionalCallExpression'].includes(ancestor.type)) return false;
    return propertyName(ancestor.callee) === 'dispatchBrowserMutation';
  });
}

const parsed = new Map();
for (const [file, source] of sources) parsed.set(file, parse(file, source));
assert(parsed.size === sources.size, `all ${sources.size} runtime authorities parse as JavaScript`);

const gatewaySource = sources.get('server/services/actionExecutionGateway.js');
const taxonomySource = sources.get('server/services/browserMutationTaxonomy.js');
const registrySource = sources.get('server/services/browserActionRegistry.js');
const coordinatorSource = sources.get('server/services/actionTransactionCoordinator.js');
const healingPolicySource = sources.get('server/services/runtimeHealingPolicy.js');
const transactionRepositorySource = sources.get('server/services/actionTransactionRepository.js');
const semanticRevealSource = sources.get('server/services/semanticTargetReveal.js');
const mcpSource = sources.get('server/services/mcp.js');
assert(count(mcpSource, "protectMcpSessionClient(session, { source: 'mcp_") === 2,
  'initial and recovered MCP clients are both gateway-protected');
assert(mcpSource.includes('return gateway.dispatchMcpTool({')
  && mcpSource.includes('defaultGateway.markSdkCallAuthorized(requestOptions'),
  'public MCP mutations enter the gateway and only consumed permits mark SDK dispatch');
assert(gatewaySource.includes('sdkAuthorizationTokens.delete(token)')
  && gatewaySource.includes('state.consumedAt == null'),
  'SDK authorization markers are consumed-permit-bound and one-use');
assert(gatewaySource.includes("require('./browserMutationTaxonomy')")
  && mcpSource.includes("require('./browserMutationTaxonomy')")
  && sources.get('server/services/actionLocatorResolver.js').includes("require('./browserMutationTaxonomy')")
  && registrySource.includes("require('./browserMutationTaxonomy')")
  && coordinatorSource.includes("require('./browserMutationTaxonomy')")
  && healingPolicySource.includes("require('./browserMutationTaxonomy')"),
  'gateway, MCP, resolver, registry, coordinator, and healing policy share one mutation taxonomy');
assert(gatewaySource.includes('requiresVerifiedSemanticTarget(toolName, args)')
  && gatewaySource.includes("'ACTION_EXECUTION_GATEWAY_BYPASS'")
  && gatewaySource.includes('transactionId: occurrenceState.transactionId')
  && gatewaySource.includes('operationId: occurrenceState.operationId')
  && gatewaySource.includes('attempt: occurrenceState.dispatchAttemptCount'),
  'gateway fails closed on raw/weak dispatch and binds every permit to transaction, occurrence, operation, phase, and attempt');
assert(gatewaySource.includes("state.status = 'dispatch_started'")
  && gatewaySource.includes('ACTION_EXECUTION_DUPLICATE_DISPATCH_BLOCKED')
  && gatewaySource.includes('recordOccurrencePostcondition')
  && gatewaySource.includes('commitOccurrence'),
  'gateway persists before dispatch, blocks duplicates, and records postcondition commit');
assert(gatewaySource.includes('const existing = await loadOccurrenceState(session, key);')
  && gatewaySource.includes('reconcileOccurrenceOnResume')
  && gatewaySource.includes("state.status = 'reconciliation_pending'")
  && gatewaySource.includes("'ACTION_EXECUTION_PERSISTENCE_REQUIRED'")
  && transactionRepositorySource.includes("await handle.open") === false
  && transactionRepositorySource.includes("await fs.promises.open(temp, 'wx', 0o600)")
  && transactionRepositorySource.includes('await handle.sync()')
  && transactionRepositorySource.includes('await fs.promises.rename(temp, target)')
  && transactionRepositorySource.includes("kind === 'occurrence'")
  && conductorSource.includes("const actionTransactionRepository = require('../actionTransactionRepository');")
  && conductorSource.includes('await actionTransactionRepository.loadTransaction(')
  && conductorSource.includes('await actionTransactionRepository.saveTransaction(')
  && conductorSource.includes('await actionTransactionRepository.saveOccurrence(')
  && conductorSource.includes('actionTransactionRepository.loadOccurrence({'),
  'interrupted actions load durable state and reconcile observation before any possible redispatch');
assert(taxonomySource.includes('\\.scrollIntoView\\s*\\(')
  && semanticRevealSource.includes('best.node.scrollIntoView({')
  && semanticRevealSource.includes('identityPreserved')
  && conductorSource.includes('const revealMutationPhaseId = `semantic-reveal:${phase?.id || \'control\'}`;')
  && conductorSource.includes('enforceExactlyOnce: true')
  && conductorSource.includes('mutationPhaseId: revealMutationPhaseId')
  && conductorSource.includes('await actionExecutionGateway.commitOccurrence({'),
  'semantic reveal is a unique-target once-per-phase mutation with post-scroll identity proof');
const actionabilityGateIndex = gatewaySource.indexOf('const targetActionabilityEvidence = options.requireActionableTarget === true');
const occurrenceBeginIndex = gatewaySource.indexOf('const occurrenceState = await beginExactlyOnceDispatch({');
assert(actionabilityGateIndex >= 0
  && occurrenceBeginIndex > actionabilityGateIndex
  && gatewaySource.includes('...transportOptions(options)')
  && gatewaySource.includes('ACTION_EXECUTION_TARGET_NOT_ACTIONABLE')
  && conductorSource.includes('dispatchOptions.requireActionableTarget = true')
  && conductorSource.includes("source: 'gateway_target_actionability'")
  && conductorSource.includes('actionExecutionGateway.evaluateTargetActionabilitySnapshot({ requirements, snapshotText })'),
  'exact target actionability is mandatory before occurrence persistence and mutation dispatch');
const universalKernelSource = sources.get('server/services/universalActionKernel.js');
const universalRuntimeSource = sources.get('server/services/conductorUniversalRuntime.js');
const executionJournalSource = sources.get('server/services/executionJournal.js');
const genericClickSource = sources.get('server/services/genericClickExecution.js');
const universalControlModelSource = sources.get('server/services/universalControlModel.js');
const alreadySatisfiedIndex = universalKernelSource.indexOf('const satisfied = controlActionAdapter.alreadySatisfied(');
const transactionCoordinationIndex = universalKernelSource.indexOf('const coordinated = await actionTransactionCoordinator.coordinateActionTransaction({');
assert(universalRuntimeSource.includes("source: 'control_exact_state_before'")
  && universalRuntimeSource.includes("captureDropdownState(ownerRef, 'dropdown_transaction_precondition')")
  && universalRuntimeSource.includes('controlStateProbe.buildControlObservation({ kind, before: ownerState, after: ownerState })')
  && alreadySatisfiedIndex >= 0
  && transactionCoordinationIndex > alreadySatisfiedIndex,
  'exact owner pre-state authoritatively commits already-satisfied controls before transaction coordination or dispatch');
assert(executionJournalSource.includes("require('./executionContinuationPolicy')")
  && count(executionJournalSource, 'decideJournalContinuation(') >= 4
  && executionJournalSource.includes('continuationPolicyDecision: compactContinuationPolicyDecision(')
  && !genericClickSource.includes('requestedFailureContinuation')
  && !universalKernelSource.includes('requestedContinuation')
  && !universalRuntimeSource.includes('requestedContinuation')
  && !conductorSource.includes('recordContinuationOutcome(')
  && !conductorSource.includes('blocking: blockingAssertion')
  && conductorSource.includes('blocking: false,\n        requiredForContinuation: false,'),
  'one central policy owns continuation; runtime adapters only project sealed journal decisions');
assert(universalControlModelSource.includes('ownerNode,')
  && universalControlModelSource.includes('interactionNode,')
  && universalControlModelSource.includes('popupNode,')
  && universalControlModelSource.includes('valueNode,')
  && universalKernelSource.indexOf('resolvedCandidate?.resolvedControl?.interactionNode?.ref')
    < universalKernelSource.indexOf('resolution?.ref,'),
  'canonical control roles are mandatory and dispatch prioritizes the interaction node over the value owner');
const semanticGuardIndex = universalKernelSource.indexOf('validateResolutionSemanticConsistency({ resolution, step, plan, phase })');
const semanticDispatchIndex = universalKernelSource.indexOf('const ref = actionLocatorRef(resolution);');
assert(universalControlModelSource.includes('MINIMUM_SEMANTIC_IDENTITY_SCORE')
  && universalControlModelSource.includes('resolvedTokenSets:')
  && semanticGuardIndex >= 0
  && semanticDispatchIndex > semanticGuardIndex
  && universalKernelSource.includes("source: 'universal_kernel_pre_dispatch'"),
  'semantic identity is scored per browser label and contradictions are rejected again immediately before dispatch');
const semanticDomMatchStart = sources.get('server/services/actionLocatorResolver.js').indexOf('function semanticControlDomMatch(');
const semanticDomMatchEnd = sources.get('server/services/actionLocatorResolver.js').indexOf('function semanticControlInteractionOwnerRow(', semanticDomMatchStart);
const semanticDomMatchSource = sources.get('server/services/actionLocatorResolver.js').slice(semanticDomMatchStart, semanticDomMatchEnd);
const semanticOwnerMapStart = sources.get('server/services/actionLocatorResolver.js').indexOf('function semanticControlInteractionOwnerRow(');
const semanticOwnerMapEnd = sources.get('server/services/actionLocatorResolver.js').indexOf('function semanticControlPublicCandidate(', semanticOwnerMapStart);
const semanticOwnerMapSource = sources.get('server/services/actionLocatorResolver.js').slice(semanticOwnerMapStart, semanticOwnerMapEnd);
assert(semanticDomMatchSource.includes('const exactNodeBinding = backendNodeMatch || snapshotRefMatch;')
  && semanticDomMatchSource.includes('const identityAnchored = exactNodeBinding || stableHits > 0 || nameMatch || exactLabelAssociation;')
  && !semanticDomMatchSource.includes('+ (ordinalMatch ?')
  && semanticOwnerMapSource.includes('actionOwnerBackendNodeId')
  && !semanticOwnerMapSource.includes('actionOwnerRoleOrdinal'),
  'DOM and accessibility controls correlate by node identity, context, labels, or relationships and never by ordinal position');
const kernelRoute = universalKernelSource.slice(universalKernelSource.indexOf('async function executeUniversalAction'));
const runtimeRoute = universalRuntimeSource.slice(universalRuntimeSource.indexOf('async function executeRun'));
const optionalDismissStart = conductorSource.indexOf('const autoCompleteOptionalDismissStepFromSnapshot');
const optionalDismissEnd = conductorSource.indexOf('const drainPassiveAndOptionalSteps', optionalDismissStart);
const optionalDismissRoute = conductorSource.slice(optionalDismissStart, optionalDismissEnd);
assert(kernelRoute.indexOf('executeOptionalPresencePreflight') >= 0
  && kernelRoute.indexOf('executeOptionalPresencePreflight') < kernelRoute.indexOf('if (family === FAMILIES.CLICK)')
  && runtimeRoute.indexOf('executeOptionalPresencePreflight') >= 0
  && runtimeRoute.indexOf('executeOptionalPresencePreflight') < runtimeRoute.indexOf('const openerIntent =')
  && conductorSource.includes('const refreshedOptionalPresence = await freshValidationSnapshot();')
  && conductorSource.includes('if (!refreshedOptionalPresence?.fresh || !refreshedOptionalPresence.text) return false;')
  && conductorSource.includes("{ optionalAbsent: true, failureImpact: 'optional_absent' }")
  && optionalDismissStart >= 0
  && optionalDismissEnd > optionalDismissStart
  && !optionalDismissRoute.includes("let snap = mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '';"),
  'optional presence is resolved from fresh evidence before any mutation and commits canonical absence');
assert(count(mcpSource, 'dispatchBrowserMutation({') >= 6,
  'direct Playwright infrastructure mutations use the browser mutation gateway');
assert(conductorSource.includes("const actionExecutionGateway = require('../actionExecutionGateway');")
  && !conductorSource.includes("const mcp = require('../mcp');")
  && !conductorSource.includes('mcpSession.client.callTool(')
  && conductorSource.includes('requireVerifiedTarget: true')
  && conductorSource.includes("schemaVersion: 'qaai-live-target-authorization-v1'")
  && conductorSource.includes('persistActionExecutionOccurrence = async (state) =>')
  && conductorSource.includes('enforceExactlyOnce: options.enforceExactlyOnce === true')
  && conductorSource.includes('|| (authoredAction && options.enforceExactlyOnce !== false)'),
  'transformed conductor has one gateway facade and zero raw SDK calls');

const rawSdkSites = [];
const forbiddenRawSdkSites = [];
const directBrowserBypasses = [];
const sdkImportsOutsideMcp = [];
const clientAssignmentsOutsideBoundary = [];
const directMutatorNames = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'hover', 'dragTo', 'selectOption',
  'setInputFiles', 'check', 'uncheck', 'goto', 'goBack', 'goForward',
  'bringToFront', 'setViewportSize', 'newPage',
]);
const protectedRawSdkFiles = new Set([
  'server/services/mcp.js',
  'server/services/actionLocatorResolver.js',
  'server/services/agents/calibrator.js',
  'server/services/agents/evidenceRepair.js',
]);
const zeroRawSdkFiles = new Set([
  'server/services/agents/conductor.js#transformed',
  'server/services/agents/healer.js',
  'server/services/runtimeHealingPolicy.js',
  'server/services/projectActionMemory.js',
  'server/services/precisionActionKernel.js',
  'server/services/universalActionKernel.js',
  'server/services/widgetExecutionKernel.js',
  'server/services/controlActionAdapter.js',
  'server/services/controlAdapterRegistry.js',
  'server/services/browserEvidenceAdapter.js',
  'server/services/browserEvidenceAdapterRegistry.js',
  'server/services/reliability/selfHealingPipeline.js',
  'server/services/evidenceReplayIr.js',
]);
const evaluateMutationPattern = browserMutationTaxonomy.EVALUATE_MUTATION_RE;

for (const [file, ast] of parsed) {
  const source = sources.get(file);
  walk(ast, [], (node, ancestors) => {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const called = propertyName(node.callee);
      if (called === 'callTool' && propertyName(node.callee?.object) === 'client') {
        rawSdkSites.push(location(file, node));
        if (!protectedRawSdkFiles.has(file)) forbiddenRawSdkSites.push(location(file, node));
      }
      if (directMutatorNames.has(called) && !insideGatewayDispatch(ancestors)) {
        directBrowserBypasses.push(`${location(file, node)} ${called}()`);
      }
      if (called === 'evaluate' && !insideGatewayDispatch(ancestors)) {
        const snippet = source.slice(node.start, node.end);
        if (evaluateMutationPattern.test(snippet)) directBrowserBypasses.push(`${location(file, node)} mutating evaluate()`);
      }
      if (node.callee?.type === 'Identifier' && node.callee.name === 'require') {
        const requested = node.arguments?.[0];
        if (requested?.type === 'StringLiteral'
          && String(requested.value).startsWith('@modelcontextprotocol/')
          && file !== 'server/services/mcp.js') {
          sdkImportsOutsideMcp.push(location(file, node));
        }
      }
    }
    if (node.type === 'AssignmentExpression' && propertyName(node.left) === 'client'
      && !['server/services/mcp.js', 'server/services/actionExecutionGateway.js'].includes(file)) {
      clientAssignmentsOutsideBoundary.push(location(file, node));
    }
  });
}

assert(forbiddenRawSdkSites.length === 0,
  'raw SDK calls exist only in centrally protected MCP, calibrator, locator, and repair boundaries',
  forbiddenRawSdkSites.join('\n'));
const zeroRawViolations = rawSdkSites.filter((site) => [...zeroRawSdkFiles].some((file) => site.startsWith(`${file}:`)));
assert(zeroRawViolations.length === 0,
  'conductor, healer, memory, replay, deterministic kernels, and adapters contain zero raw SDK calls',
  zeroRawViolations.join('\n'));
assert(sdkImportsOutsideMcp.length === 0,
  'only the MCP boundary imports the raw MCP SDK',
  sdkImportsOutsideMcp.join('\n'));
assert(clientAssignmentsOutsideBoundary.length === 0,
  'only MCP and ActionExecutionGateway may install or replace session clients',
  clientAssignmentsOutsideBoundary.join('\n'));
assert(directBrowserBypasses.length === 0,
  'direct browser mutation bypasses found = 0',
  directBrowserBypasses.join('\n'));

if (process.exitCode) process.exit(process.exitCode);
console.log(`RESULT: GREEN - ${assertions} gateway invariants passed; ${rawSdkSites.length} protected raw SDK site(s); 0 mutation bypasses.`);
