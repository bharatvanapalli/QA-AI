"use strict";
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

  // Find the category-filter-happy-path result
  for (const r of results) {
    if (!r.replayIrJson) continue;
    let ir;
    try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const str = JSON.stringify(ir);
    if (!str.includes('Women - Dress')) continue;

    console.log(`\n=== RunResult ${r.id.slice(0,8)} (${r.status}) ===`);
    // Print the full IR structure (truncated)
    const irObj = ir && ir.ir ? ir.ir : ir;
    console.log("IR top-level keys:", Object.keys(irObj || {}));
    // Print steps structure
    const steps = irObj.steps || [];
    console.log("Steps count:", steps.length);
    for (const s of steps.slice(0, 5)) {
      console.log("  Step:", JSON.stringify(s).slice(0, 500));
    }
    break;
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
