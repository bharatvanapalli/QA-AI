'use strict';
const prisma = require('../server/prisma');
const { decodeJson } = require('../server/services/jsonField');

(async () => {
  const c = await prisma.testCase.findFirst({
    where: { name: { contains: 'Edit Fields' } },
  });
  if (!c) {
    console.log('Case not found!');
    process.exit(1);
  }
  console.log(`Case Name: ${c.name}`);
  console.log('--- STEPS ---');
  const steps = decodeJson(c.steps);
  steps.forEach(s => console.log(JSON.stringify(s, null, 2)));
  await prisma.$disconnect();
})();
