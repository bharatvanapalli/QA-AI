const { PrismaClient } = require('@prisma/client');
const path = require('path');
const mcp = require('./server/services/mcp');
const { compileOperationContractV2 } = require('./server/services/operationContractV2');
const { createControllerMcpRuntimeAdapter } = require('./server/services/controllerMcpRuntimeAdapter');

const prisma = new PrismaClient();

async function run() {
  const tc = await prisma.testCase.findFirst({
    where: { name: { contains: 'Click Actions' } },
    orderBy: { createdAt: 'desc' }
  });
  
  if (!tc) {
    console.log('Test case not found');
    return;
  }
  
  console.log(`Found TC: ${tc.name}, ID: ${tc.id}`);
  
  const steps = tc.steps ? JSON.parse(tc.steps) : [];
  const assertions = tc.assertions ? JSON.parse(tc.assertions) : [];
  
  console.log(`Parsed ${steps.length} steps and ${assertions.length} assertions.`);
  
  const contract = compileOperationContractV2({
    ...tc,
    steps,
    assertions
  });
  
  console.log(`Compiled Contract has ${contract.operations.length} operations.`);
  
  console.log('\n--- Operations ---');
  for (const op of contract.operations) {
    console.log(`[${op.ordinal}] ${op.kind} | ${op.type} | Target: ${op.targetIdentity ? op.targetIdentity.label : 'null'}`);
  }
  
  await prisma.$disconnect();
}

run().catch(console.error);
