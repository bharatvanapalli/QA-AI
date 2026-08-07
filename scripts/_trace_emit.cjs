"use strict";
// Trace what emitLocatorResolver actually produces
const path = require("path");
const { normalizeCandidates } = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "_candidateNormalize"));

// Simulate selectStaticLocator
function q(s) { return JSON.stringify(s); }
function selectStaticLocator(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const role = candidates.find((c) => c.strategy === 'role' && c.role);
  if (role) {
    return role.name
      ? `page.getByRole(${q(role.role)}, { name: ${q(role.name)} })`
      : `page.getByRole(${q(role.role)})`;
  }
  const label = candidates.find((c) => c.strategy === 'label' && c.text);
  if (label) return `page.getByLabel(${q(label.text)})`;
  const placeholder = candidates.find((c) => c.strategy === 'placeholder' && c.text);
  if (placeholder) return `page.getByPlaceholder(${q(placeholder.text)})`;
  const text = candidates.find((c) => c.strategy === 'text' && c.text);
  if (text) return `page.getByText(${q(text.text)}, { exact: true })`;
  return null;
}

const candidates = [
  {"strategy":"role","role":"link","name":" Women","contextText":["Category"," Women"]},
  {"strategy":"text","text":"Women category link","contextText":["Category"," Women"]},
  {"strategy":"role","role":"link","name":"Women category","contextText":["Category"," Women"]},
  {"strategy":"text","text":"Women category","contextText":["Category"," Women"]}
];

const norm = normalizeCandidates(candidates);
console.log("normalizeCandidates result:", JSON.stringify(norm, null, 2));
const expr = selectStaticLocator(norm);
console.log("selectStaticLocator result:", expr);
console.log("\nExpected: page.getByRole(\"link\", { name: \"Women\" })");
console.log("Match:", expr === 'page.getByRole("link", { name: "Women" })');
