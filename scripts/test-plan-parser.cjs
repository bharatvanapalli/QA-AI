'use strict';
const prisma = require('../server/prisma');
const { buildRequirementUnderstandingV1 } = require('../server/services/requirementUnderstandingV1');

(async () => {
  try {
    const project = await prisma.project.findFirst({
      where: { name: { contains: 'letcode' } },
      include: { requirements: true },
    });

    const reqContent = project.requirements[0].content;
    console.log(`Parsing requirement content (${reqContent.length} bytes)...`);

    const result = buildRequirementUnderstandingV1({
      requirements: [{ id: project.requirements[0].id, content: reqContent }],
      project: { id: project.id, name: project.name, targetUrl: project.targetUrl },
    });

    console.log('--- REQUIREMENT UNDERSTANDING V1 ---');
    console.log(`Clauses Count: ${result?.clauses?.length || 0}`);
    console.log(`User flows Count: ${result?.userFlows?.length || 0}`);

    if (result?.clauses?.length) {
      console.log('First 5 Clauses:');
      result.clauses.slice(0, 5).forEach((c, idx) => {
        console.log(`  [${idx + 1}] Category: "${c.category}", Heading: "${c.heading || ''}", Title: "${c.title}"`);
      });
    }

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error in requirement understanding:', err);
  }
})();
