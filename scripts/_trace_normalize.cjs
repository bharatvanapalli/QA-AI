"use strict";
// Trace exactly what normalizeCandidates produces for the Women category candidates
const path = require("path");
const { normalizeCandidates, semanticNameForRole, isSyntheticTextCandidate, normalizeCandidate } = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "_candidateNormalize"));

const candidates = [
  {"strategy":"role","role":"link","name":" Women","contextText":["Category"," Women"]},
  {"strategy":"text","text":"Women category link","contextText":["Category"," Women"]},
  {"strategy":"role","role":"link","name":"Women category","contextText":["Category"," Women"]},
  {"strategy":"text","text":"Women category","contextText":["Category"," Women"]}
];

console.log("=== Raw candidates ===");
candidates.forEach((c, i) => console.log(`${i}: ${JSON.stringify(c)}`));

console.log("\n=== After normalizeCandidate each ===");
candidates.forEach((c, i) => {
  const n = normalizeCandidate(c);
  console.log(`${i}: ${JSON.stringify(n)}`);
});

console.log("\n=== isSyntheticTextCandidate for each (after normalize) ===");
candidates.forEach((c, i) => {
  const n = normalizeCandidate(c);
  console.log(`${i}: ${isSyntheticTextCandidate(n)}`);
});

console.log("\n=== After normalizeCandidates (full pipeline) ===");
const result = normalizeCandidates(candidates);
console.log(JSON.stringify(result, null, 2));

console.log("\n=== semanticNameForRole tests ===");
console.log(`semanticNameForRole("link", " Women") = "${semanticNameForRole("link", " Women")}"`);
console.log(`semanticNameForRole("link", "Women category") = "${semanticNameForRole("link", "Women category")}"`);
console.log(`semanticNameForRole("link", "Men category") = "${semanticNameForRole("link", "Men category")}"`);
