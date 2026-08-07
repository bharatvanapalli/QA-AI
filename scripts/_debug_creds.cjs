'use strict';
const emitter = require('../server/services/codegen/replayEmitter');
const realCreds = new Set(['Admin', 'RealPass123']);
const trail = [
  { tool: 'browser_fill_form', args: { fields: [
    { name: 'Username', type: 'textbox', value: 'Admin' },
    { name: 'Password', type: 'textbox', value: 'WrongPass!' },
  ] }, ok: true },
];
const r = emitter.buildReplayIR({ caseId: 'TC2', trail, verdictStatus: 'fail', credentialValues: realCreds });
const fills = r.ir.steps.filter(s => s.op === 'act' && s.action === 'fill');
console.log('fill steps:');
fills.forEach((f, i) => console.log(` [${i}]`, JSON.stringify(f)));

// Also test scalar
const scalar = [{ tool: 'browser_fill', args: { element: 'Password', value: 'WrongScalar!' }, ok: true }];
const r2 = emitter.buildReplayIR({ caseId: 'TC4', trail: scalar, verdictStatus: 'fail', credentialValues: realCreds });
const fills2 = r2.ir.steps.filter(s => s.op === 'act' && s.action === 'fill');
console.log('scalar fill steps:');
fills2.forEach((f, i) => console.log(` [${i}]`, JSON.stringify(f)));
