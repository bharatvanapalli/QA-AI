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
  // Look for QAAI_* env var captures in each IR
  const envCaptures = {};
  for (const r of results) {
    if (!r.replayIrJson) continue;
    let ir;
    try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    // Walk all steps looking for dynamicEnvCaptures or similar
    const steps = Array.isArray(ir.steps) ? ir.steps : (Array.isArray(ir) ? ir : []);
    for (const step of steps) {
      if (step.dynamicEnvCaptures && typeof step.dynamicEnvCaptures === 'object') {
        Object.assign(envCaptures, step.dynamicEnvCaptures);
      }
      // Also check actions
      if (Array.isArray(step.actions)) {
        for (const act of step.actions) {
          if (act.dynamicEnvCaptures) Object.assign(envCaptures, act.dynamicEnvCaptures);
          if (act.envCaptures) Object.assign(envCaptures, act.envCaptures);
        }
      }
    }
    // Also check top-level dynamicEnvCaptures
    if (ir.dynamicEnvCaptures) Object.assign(envCaptures, ir.dynamicEnvCaptures);
    if (ir.envCaptures) Object.assign(envCaptures, ir.envCaptures);
  }
  console.log("Captured env vars:", JSON.stringify(envCaptures, null, 2));

  // Also print raw IR keys for one result with QAAI_ references
  const { collectEnvVars } = require(path.join(__dirname, "..", "server", "services", "codegen", "replayExport"));
  const envelopes = results.map(r => {
    if (!r.replayIrJson) return null;
    try { return JSON.parse(r.replayIrJson); } catch { return null; }
  }).filter(Boolean);
  const envVarNames = collectEnvVars(envelopes, []);
  console.log("Env var NAMES needed:", envVarNames);
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
