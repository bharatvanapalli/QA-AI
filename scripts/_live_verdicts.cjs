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
    orderBy: { id: 'asc' }
  });

  for (const r of results) {
    let title = r.id.slice(0,8);
    if (r.replayIrJson) {
      try {
        const ir = JSON.parse(r.replayIrJson);
        const irObj = ir && ir.ir ? ir.ir : ir;
        title = irObj.title || title;
      } catch {}
    }
    // Map to spec filename
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    console.log(`${r.status.padEnd(8)} | ${title}`);
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
