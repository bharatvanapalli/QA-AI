'use strict';

const prisma = require('./server/prisma');
const { compileOperationContractV2 } = require('./server/services/operationContractV2');

(async () => {
  try {
    const tc = await prisma.testCase.findFirst({
      where: { name: { contains: 'Edit Fields' } }
    });
    if (!tc) {
      console.log('Edit Fields test case not found');
      return;
    }
    console.log('Testing compilation for:', tc.name);
    const steps = JSON.parse(tc.steps || '[]');
    console.log('Raw steps count:', steps.length);
    
    const contract = compileOperationContractV2({
      ...tc,
      steps
    });
    console.log('\nCompilation SUCCESS! Total operations:', contract.operations.length);
    console.log('Actions count:', contract.actions.length, '| Assertions count:', contract.assertions.length);
    
    contract.operations.forEach((op, idx) => {
      console.log(`  [${idx + 1}] Kind=${op.kind} | Type=${op.type} | Target=${op.targetIdentity?.label || 'null'} | Value=${op.value || op.expected || 'null'}`);
    });
  } catch (err) {
    console.error('Compilation Error:', err);
    if (err.findings) {
      console.error('Findings:', JSON.stringify(err.findings, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
})();
