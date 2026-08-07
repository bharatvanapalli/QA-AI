'use strict';

const pom = require('./pom');
const playwrightJs = require('./playwrightJs');
const playwrightBdd = require('./playwrightBdd');
const selenium = require('./selenium');
const seleniumBdd = require('./seleniumBdd');

const REGISTRY = {
  'playwright-pom': pom,             // Playwright + Page Object Model (TypeScript)
  'playwright-flat': pom,            // Playwright flat (TypeScript) — POM generator, single-file layout handled by caller
  'playwright-js': playwrightJs,     // Playwright + Page Object Model (JavaScript)
  'playwright-bdd': playwrightBdd,   // Playwright BDD (Cucumber via playwright-bdd package)
  'cucumber-playwright': playwrightBdd, // legacy key → the fixed BDD generator
  'selenium-java': selenium,         // Selenium 4 + TestNG (Java, Maven, POM)
  'selenium-bdd': seleniumBdd,       // Selenium BDD (Cucumber-JVM + TestNG, Java, Maven)
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

// ── Journey codegen (P1) — a dependsOnIds chain emitted as ONE spec. Only some
// frameworks implement it (Playwright TS/JS today); the rest gracefully fall
// back to per-case specs via supportsJourney() so nothing regresses.
function supportsJourney(framework) {
  return typeof get(framework).generateJourney === 'function';
}
async function generateJourney({ framework, ...opts }) {
  const g = get(framework);
  if (typeof g.generateJourney !== 'function') return null;
  return g.generateJourney(opts);
}
function layoutForJourney(framework, scenario, journeyCases) {
  const g = get(framework);
  return typeof g.layoutJourney === 'function' ? g.layoutJourney(scenario, journeyCases) : null;
}
function splitFilesJourneyFor(framework, content, lay) {
  const g = get(framework);
  return typeof g.splitFilesJourney === 'function' ? g.splitFilesJourney(content, lay) : { [lay.testFile || lay.primaryFile]: content };
}

module.exports = { generate, layoutFor, REGISTRY, get, supportsJourney, generateJourney, layoutForJourney, splitFilesJourneyFor };
