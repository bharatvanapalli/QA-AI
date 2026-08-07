const path = require("path");
try { require(path.join(__dirname, "..", "server", "node_modules", "dotenv")).config({ path: path.join(__dirname, "..", ".env") }); } catch(_) {}
const { PrismaClient } = require("../server/node_modules/@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.runResult.findMany({
    where: { runId: { startsWith: "707ba2ac" } },
    include: { testCase: { select: { name: true } } }
  });
  for (const r of rows) {
    const name = r.testCase && r.testCase.name || "";
    if (!/empty username validation error/i.test(name)) continue;
    const envelope = JSON.parse(r.replayIrJson || "{}");
    const steps = (envelope.ir && envelope.ir.steps) || [];
    console.log("CASE:", name);
    for (const s of steps) {
      console.log("  keys:", Object.keys(s).join(","));
      console.log("  script:", JSON.stringify(s.script));
      console.log("  expected:", JSON.stringify(s.expected));
    }
    break;
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });