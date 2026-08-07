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
    if (!/both fields empty/i.test(name)) continue;
    const envelope = JSON.parse(r.replayIrJson || "{}");
    const steps = (envelope.ir && envelope.ir.steps) || [];
    console.log("CASE:", name, "steps:", steps.length);
    for (const s of steps) {
      if (s.op === "act") console.log("  ACT action=" + s.action);
      if (s.op === "assert") console.log("  ASSERT ch=" + s.channel + " exp=" + JSON.stringify(s.expected));
    }
    break;
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });