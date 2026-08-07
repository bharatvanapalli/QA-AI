'use strict';
const emitter = require('../server/services/codegen/replayEmitter');
const realCreds = new Set(['Admin', 'RealPass123']);
const scalarTrail = [
  { tool: 'browser_fill', args: { element: 'Password', value: 'WrongScalar!' }, ok: true },
];
const r = emitter.buildReplayIR({ caseId: 'TC4', trail: scalarTrail, verdictStatus: 'fail', credentialValues: realCreds });
console.log('complete:', r.complete);
console.log('gaps:', JSON.stringify(r.gaps));
console.log('steps:', JSON.stringify(r.ir.steps));
