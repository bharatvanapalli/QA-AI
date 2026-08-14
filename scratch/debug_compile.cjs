const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
const { compileOperationContractV2 } = require('../server/services/operationContractV2');

(async () => {
  const tc = await prisma.testCase.findUnique({ where: { id: '4faa01b1-41b0-481b-957c-1ae2a0160df4' } });
  try {
    const contract = compileOperationContractV2({
      ...tc,
      steps: JSON.parse(tc.steps || '[]'),
      assertions: JSON.parse(tc.assertions || '[]'),
    });
    console.log('COMPILED OK, operations:', contract.operations.length);
  } catch (err) {
    console.log('ERROR:', err.message);
    console.log('FINDINGS:', JSON.stringify(err.findings || err.details || err, null, 2));
  }
  await prisma.$disconnect();
})();
