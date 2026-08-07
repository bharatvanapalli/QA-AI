"use strict";
const path = require("path");

// Patch normalizeCandidate to trace per-candidate
const normMod = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "_candidateNormalize"));
const origNC = normMod.normalizeCandidate;
normMod.normalizeCandidate = function(c) {
  const result = origNC(c);
  if (c && (c.name || c.text || '').includes('Women')) {
    console.log(`[normalizeCandidate] IN: ${JSON.stringify(c)}`);
    console.log(`[normalizeCandidate] OUT: ${JSON.stringify(result)}`);
  }
  return result;
};
const origISC = normMod.isSyntheticTextCandidate;
normMod.isSyntheticTextCandidate = function(c) {
  const result = origISC(c);
  if (c && (c.name || c.text || '').includes('Women')) {
    console.log(`[isSyntheticTextCandidate] ${JSON.stringify(c)} => ${result}`);
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
    if (!JSON.stringify(irObj).includes('Women - Dress')) continue;

    // Print the resolve step candidates directly from DB data
    const steps = irObj.steps || [];
    for (const step of steps) {
      if (step.op === 'resolve' && JSON.stringify(step.candidates||[]).includes('Women')) {
        console.log("\n=== Resolve step candidates from DB ===");
        console.log(JSON.stringify(step.candidates, null, 2));
      }
    }

    const registry = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "index"));
    const contract = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "frameworkAdapter"));
    const adapter = registry.getAdapter("playwright-reference-js");
    contract.compileReplayIR(adapter, irObj, { runResultId: r.id, testCaseId: 'tc', scenarioName: 'test' });
    break;
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
