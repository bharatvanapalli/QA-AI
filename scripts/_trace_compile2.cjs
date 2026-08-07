"use strict";
// Add logging to trace exactly what normalizeCandidates gets called with
const path = require("path");

// Monkey-patch _candidateNormalize BEFORE requiring other modules
const normMod = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "_candidateNormalize"));
const origNorm = normMod.normalizeCandidates;
normMod.normalizeCandidates = function(cands) {
  const result = origNorm(cands);
  if (cands && cands.some(c => c && (c.name || '').includes('Women'))) {
    console.log("\n[TRACE] normalizeCandidates called with:", JSON.stringify(cands));
    console.log("[TRACE] normalizeCandidates result:", JSON.stringify(result));
  }
  return result;
};

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { PrismaClient } = require(path.join(__dirname, "..", "server", "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();
const RUN_ID = "30637d3e-e147-452f-b94f-3bc3c306043e";

async function main() {
  const results = await prisma.runResult.findMany({
    where: { runId: RUN_ID },
    select: { id: true, status: true, replayIrJson: true },
  });

  for (const r of results) {
    if (!r.replayIrJson) continue;
    let ir;
    try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const irObj = ir && ir.ir ? ir.ir : ir;
    const str = JSON.stringify(irObj);
    if (!str.includes('Women - Dress')) continue;

    const registry = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "index"));
    const contract = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "frameworkAdapter"));
    const adapter = registry.getAdapter("playwright-reference-js");

    const compiled = contract.compileReplayIR(adapter, irObj, {
      runResultId: r.id, testCaseId: 'test-case', scenarioName: 'Category Filter — Happy Path'
    });
    break;
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
