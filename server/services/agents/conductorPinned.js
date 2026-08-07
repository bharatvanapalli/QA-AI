'use strict';

// Atomic controller cutover: only this runtime may schedule, mutate, recover,
// commit, continue, or project a verdict.
const conductor = require('./controllerConductor');
const executionDataPinScope = require('../executionDataPinScope');

module.exports = Object.freeze({
  ...conductor,
  run(opts) {
    return executionDataPinScope.runWithExecutionDataPins(opts, () => conductor.run(opts));
  },
});
