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

  // Find the category-filter-happy-path result — look for one that has "Women" in the IR
  for (const r of results) {
    if (!r.replayIrJson) continue;
    let ir;
    try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const str = JSON.stringify(ir);
    if (!str.includes('Women') && !str.includes('category')) continue;

    // Print the act steps with role/name info
    const steps = (ir && ir.ir && Array.isArray(ir.ir.steps)) ? ir.ir.steps : [];
    const actSteps = steps.filter(s => s.op === 'act' && s.action === 'click');
    if (actSteps.length === 0) continue;

    console.log(`\n=== RunResult ${r.id.slice(0,8)} (${r.status}) ===`);
    for (const s of actSteps) {
      console.log("  click step:", JSON.stringify({
        target: s.target,
        role: s.role,
        name: s.name,
        locators: s.locators,
        candidates: s.candidates,
        ref: s.ref,
        selector: s.selector,
      }).slice(0, 400));
    }
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
