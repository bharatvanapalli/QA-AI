const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();
async function main() {
  const run = await prisma.run.findFirst({
    orderBy: { startedAt: 'desc' },
    include: {
      results: {
        include: { testCase: true }
      }
    }
  });
  if (run && run.results && run.results.length > 0) {
    fs.writeFileSync('C:/Users/2461898/.gemini/antigravity/brain/004ba261-7ead-4687-98ba-b9ab30ae978d/scratch/run_details.json', JSON.stringify({
      runId: run.id,
      testCaseId: run.results[0].testCaseId,
      stepResults: run.results[0].stepResults ? JSON.parse(run.results[0].stepResults) : [],
    }, null, 2));
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
