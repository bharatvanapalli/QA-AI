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

  for (const r of results) {
    if (!r.replayIrJson) continue;
    let ir;
    try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const irObj = ir && ir.ir ? ir.ir : ir;
    const title = irObj.title || "";

    console.log("\n=== " + title + " [" + r.status + "] ===");
    const steps = irObj.steps || [];
    for (const step of steps) {
      if (step.op === "navigate") {
        console.log("  navigate → " + step.url);
      } else if (step.op === "resolve") {
        const cands = JSON.stringify(step.candidates || []);
        console.log("  resolve " + step.as + ": " + cands.slice(0, 200));
      } else if (step.op === "act") {
        console.log("  act " + step.action + " → " + step.target);
      } else if (step.op === "assert") {
        const text = (step.text || step.assertionText || "").slice(0, 80);
        const type = step.assertionType || step.type || "";
        const tier = step.priority || step.tier || "";
        console.log("  assert [" + tier + "/" + type + "] " + text);
      } else if (step.op === "handlePopup") {
        console.log("  handlePopup: " + JSON.stringify(step.known || []).slice(0, 100));
      }
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
