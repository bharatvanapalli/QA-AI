#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

let pass = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  pass += 1;
  console.log(`✓ ${message}`);
}

const reports = read('src', 'pages', 'Reports.jsx');
const runs = read('server', 'services', 'runs.js');

ok(/const compareReportResults\s*=/.test(reports), 'Reports.jsx defines a canonical report-result comparator');
ok(reports.includes('const orderedResults = [...(Array.isArray(results) ? results : [])].sort(compareReportResults);'), 'ResultsByScenario sorts incoming results before grouping');
ok(/Array\.from\(map\.values\(\)\)\s*\n\s*\.sort\(\(a,\s*b\)\s*=>\s*compareReportResults\(a\.items\[0\],\s*b\.items\[0\]\)\)/.test(reports), 'scenario groups are sorted by their first canonical result');
ok(reports.includes('const orderedItems = [...(Array.isArray(items) ? items : [])].sort(compareReportResults);'), 'case groups sort raw items before grouping');
ok(reports.includes('rows: [...group.rows].sort(compareReportResults)'), 'data-driven rows are sorted before rendering');

ok(/function compareRunResultsForReport\(a,\s*b\)/.test(runs), 'runs.getRun defines the backend report-result comparator');
ok(/run\.results\.sort\(compareRunResultsForReport\)/.test(runs), 'getRun sorts results before returning them');
ok(/parseCaseLabelOrder\(a\?\.caseLabel\)/.test(runs), 'backend comparator uses stable Sx/Cy case labels');

console.log(`PASS verify_reports_ordering (${pass} checks)`);
