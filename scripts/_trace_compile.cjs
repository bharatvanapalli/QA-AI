"use strict";
// Trace what compileReplayIR actually produces for the category-filter case
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { PrismaClient } = require(path.join(__dirname, "..", "server", "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();
const RUN_ID = "30637d3e-e147-452f-b94f-3bc3c306043e";

async function main() {
  const results = await prisma.runResult.findMany({
    where: { runId: RUN_ID },
    select: { id: true, status: true, replayIrJson: true },
  });

  // Find the category-filter-happy-path case
  for (const r of results) {
    if (!r.replayIrJson) continue;
    let ir;
    try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const irObj = ir && ir.ir ? ir.ir : ir;
    const str = JSON.stringify(irObj);
    if (!str.includes('Women - Dress')) continue;

    console.log(`Found category-filter result: ${r.id}`);

    // Use compileReplayIR directly
    const registry = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "index"));
    const contract = require(path.join(__dirname, "..", "server", "services", "codegen", "adapters", "frameworkAdapter"));
    const adapter = registry.getAdapter("playwright-reference-js");

    const compiled = contract.compileReplayIR(adapter, irObj, {
      runResultId: r.id,
      testCaseId: 'test-case',
      scenarioName: 'Category Filter — Happy Path'
    });

    const specPath = Object.keys(compiled.files)[0];
    const specContent = compiled.files[specPath];
    console.log("\n=== Generated spec ===");
    console.log(specContent);
    break;
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message, "\n", e.stack?.split("\n").slice(0,5).join("\n")); await prisma.$disconnect(); process.exit(1); });
