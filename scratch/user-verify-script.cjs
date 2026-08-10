const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const p = new PrismaClient();
const RUN_ID = '0d244694-be01-4210-abeb-fb267f56c209';
const TEST_CASE_ID = '86398d13-d6b2-4330-8a96-c95dfd217da9';
(async () => {
  const run = await p.run.findUnique({ where: { id: RUN_ID } });
  console.log('run:', run.status, run.startedAt, run.completedAt);
  const result = await p.runResult.findFirst({ where: { runId: RUN_ID, testCaseId: TEST_CASE_ID } });
  console.log('result:', result?.status, result?.error);

  const jnlDir = `playwright/controller-journal/${RUN_ID}`;
  if (!fs.existsSync(jnlDir)) {
      console.log('Journal dir missing:', jnlDir);
      return;
  }
  const files = fs.readdirSync(jnlDir).filter(f => f.endsWith('.jsonl'));
  const lines = files.flatMap(f => fs.readFileSync(jnlDir + '/' + f, 'utf8').split('\n').filter(Boolean));
  lines.forEach(l => {
    try {
      const entry = JSON.parse(l);
      if (entry.eventType === 'TERMINAL_DECISION') {
        console.log(`[DECISION] ${entry.operationId} : ${entry.terminalDecision?.reason}`);
      }
    } catch(e) {}
  });
})();
