'use strict';
const prisma = require('../server/prisma');
const { compileOperationContractV2 } = require('../server/services/operationContractV2');

(async () => {
  try {
    const cases = await prisma.testCase.findMany({
      where: { project: { name: { contains: 'letcode' } } },
    });

    console.log(`Verifying operation contract compilation for ${cases.length} cases...`);

    let failCount = 0;
    cases.forEach((c) => {
      const steps = c.steps ? JSON.parse(c.steps) : [];
      const assertions = c.assertions ? JSON.parse(c.assertions) : [];

      try {
        compileOperationContractV2({
          caseId: c.id,
          steps,
          assertions,
        });
      } catch (err) {
        failCount++;
        console.error(`FAILED for case "${c.name}":`, err.message, err.findings);
      }
    });

    console.log(`\nVERIFICATION SUMMARY: ${cases.length - failCount}/${cases.length} cases compiled cleanly! Fails: ${failCount}`);

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
})();
