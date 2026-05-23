'use strict';

const pom = require('./pom');
const cucumber = require('./cucumber');
const selenium = require('./selenium');

const REGISTRY = {
  'playwright-pom': pom,
  'playwright-flat': pom, // same generator, slightly different output template — close enough for now
  'cucumber-playwright': cucumber,
  'selenium-java': selenium,
};

function get(framework) {
  return REGISTRY[framework] || pom;
}

async function generate({ framework, ...opts }) {
  const g = get(framework);
  return g.generate(opts);
}

function layoutFor(framework, scenario, testCase) {
  return get(framework).layout(scenario, testCase);
}

module.exports = { generate, layoutFor, REGISTRY, get };
