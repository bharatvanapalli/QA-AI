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

  // Find steps that have valueRef with env: prefix and also rawValue
  for (const r of results) {
    if (!r.replayIrJson) continue;
    let ir;
    try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const envelope = ir;
    const steps = (envelope && envelope.ir && Array.isArray(envelope.ir.steps)) ? envelope.ir.steps : [];
    for (const step of steps) {
      if (step.valueRef && /^env:/i.test(step.valueRef)) {
        console.log(`Result ${r.id.slice(0,8)} | valueRef=${step.valueRef} | rawValue=${JSON.stringify(step.rawValue)} | op=${step.op} | action=${step.action}`);
      }
      // Also check for captured assertion text
      if (step.op === 'assertion' && step.value) {
        if (/QAAI_|search_product/i.test(JSON.stringify(step))) {
          console.log(`  Assertion step:`, JSON.stringify(step).slice(0, 200));
        }
      }
    }
  }

  // Also look at the run's targetUrl
  const run = await prisma.run.findUnique({ where: { id: RUN_ID }, select: { id: true } });
  const proj = await prisma.project.findUnique({ where: { id: "4cc6772c-ea93-4c26-b478-48d779d1fccb" }, select: { baseUrl: true } });
  console.log("Project baseUrl:", proj?.baseUrl);

  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
