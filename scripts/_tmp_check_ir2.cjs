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
    if (!/wrong password|invalid cred/i.test(name)) continue;
    const raw = String(r.replayIrJson || "").slice(0, 2000);
    console.log("RAW:", raw);
    break;
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
