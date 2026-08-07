require('dotenv').config();
const prisma = require('./server/prisma');

const runId = process.argv[2];
const testCaseId = process.argv[3];
const stepIndex = Number(process.argv[4]);
if (!runId || !testCaseId || !Number.isFinite(stepIndex)) {
  throw new Error('usage: node .codex-inspect-run-step.cjs <runId> <testCaseId> <stepIndex>');
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

(async () => {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { results: true },
  });
  const result = run?.results?.find((row) => row.testCaseId === testCaseId) || null;
  const steps = parseJson(result?.stepResults, []);
  const step = steps.find((row) => Number(row?.index || row?.ordinal) === stepIndex) || null;
  const trail = parseJson(result?.actionTrail, []);
  const relatedTrail = trail.filter((row) => {
    const rowIndex = Number(row?.stepIndex || row?.index || row?.ordinal);
    const target = String(row?.target || row?.element || row?.args?.target || row?.args?.element || '');
    return rowIndex === stepIndex || /Owning Organization/i.test(target);
  });
  console.log(JSON.stringify({
    run: run ? { id: run.id, status: run.status } : null,
    result: result ? {
      id: result.id,
      status: result.status,
      blockedReason: result.blockedReason,
      error: result.error,
      fields: Object.keys(result),
    } : null,
    step,
    relatedTrail,
  }, null, 2));
})().finally(() => prisma.$disconnect());
