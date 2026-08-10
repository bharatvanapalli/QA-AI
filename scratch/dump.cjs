const { PrismaClient } = require('@prisma/client'); 
const prisma = new PrismaClient(); 
async function run() { 
  const res = await prisma.runResult.findFirst({ where: { runId: 'dfed658a-3afa-43f6-aa1c-fc595f4cd4f1' } }); 
  require('fs').writeFileSync('scratch/verify_run_results3.json', res.stepResults); 
  await prisma.$disconnect(); 
} 
run();
