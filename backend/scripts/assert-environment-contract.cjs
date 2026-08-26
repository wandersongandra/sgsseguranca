'use strict';

// Scripts run outside Nest. The compiled contract is the same source used by
// API/worker bootstrap; failing closed is safer than silently using fallbacks.
const contract = require('../dist/shared/config/environment-contract.js');

function assertScriptEnvironment(options) {
  try {
    contract.validateCommonEnvironment(process.env, options);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'ENVIRONMENT_INVALID';
    throw new Error(`[environment-contract] ${message}`);
  }
}

module.exports = { assertScriptEnvironment };
