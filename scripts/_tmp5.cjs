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
    if (!/admin navigation.*modules visible/i.test(name)) continue;
    const envelope = JSON.parse(r.replayIrJson || "{}");
    const steps = (envelope.ir && envelope.ir.steps) || [];
    console.log("CASE:", name, "steps:", steps.length, "verdict:", envelope.ir && envelope.ir.verdict && envelope.ir.verdict.status);
    for (const s of steps) {
      if (s.op === "act") console.log("  ACT action=" + s.action + " url=" + s.url + " valueRef=" + s.valueRef);
      if (s.op === "assert") console.log("  ASSERT channel=" + s.channel + " expected=" + JSON.stringify(s.expected));
      if (s.op === "resolve") console.log("  RESOLVE as=" + s.as + " candidates=" + JSON.stringify((s.candidates||[]).slice(0,1)));
    }
    break;
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });