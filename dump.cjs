const { PrismaClient } = require('@prisma/client'); 
const prisma = new PrismaClient(); 
async function run() { 
  const res = await prisma.runResult.findFirst({ where: { runId: '1371e31a-f69f-4555-96e8-38a0e174de56' } }); 
  require('fs').writeFileSync('scratch/verify_run_results6.json', JSON.stringify(res.stepResults, null, 2)); 
  await prisma.$disconnect(); 
} 
run();
