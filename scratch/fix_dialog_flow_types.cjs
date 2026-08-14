const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();

const IDS = [
  '4faa01b1-41b0-481b-957c-1ae2a0160df4', // LetCode Dialog Flow
  '53892d8a-4189-42e0-bd76-2d2a8c9be553', // Click Actions End-to-End Flow
  '929310e9-0ccc-445d-9bce-94f72718d91c', // Edit Fields End-to-End Flow
];

(async () => {
  for (const id of IDS) {
    const tc = await prisma.testCase.findUnique({ where: { id } });
    const steps = JSON.parse(tc.steps);
    for (const s of steps) {
      if (s.action && !s.type) s.type = s.action;
    }
    await prisma.testCase.update({ where: { id: tc.id }, data: { steps: JSON.stringify(steps) } });
    console.log('patched:', tc.name);
  }
  await prisma.$disconnect();
})();
