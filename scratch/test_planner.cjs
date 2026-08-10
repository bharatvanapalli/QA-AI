const { PrismaClient } = require('@prisma/client');
const { compileOperationContractV2 } = require('../server/services/operationContractV2.js');
const { planOperation } = require('../server/services/controllerTypedAdapterRegistry.js');
const { assertSemanticCaseContract } = require('../server/services/caseContractSemanticValidator.js');

const prisma = new PrismaClient();

async function run() {
  const tc = await prisma.testCase.findUnique({
    where: { id: 'd7b7cf88-c106-4b06-9d04-abe4c6e4cfcc' } // Navigate to OrangeHRM TC
  });
  const steps = JSON.parse(tc.steps);
  const contract = assertSemanticCaseContract({ steps }, { mode: 'v1_authored' });
  const compiled = compileOperationContractV2(contract);

  for (const op of compiled.operations) {
    const planned = planOperation(op, {
        resolveVariable: () => null,
        resolveElement: () => null,
        resolveReference: () => null,
        resolveIdentity: () => null,
        evaluateExpression: () => null,
        recordFinding: () => null,
        contextVariables: {},
    });
    console.log(`Op ${op.order}: [${op.type}] mutation = ${planned?.mutation?.toolName} url=${planned?.mutation?.args?.url}`);
  }
  await prisma.$disconnect();
}

run().catch(console.error);
