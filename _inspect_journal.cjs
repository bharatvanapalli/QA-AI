'use strict';

const prisma = require('./server/prisma');

(async () => {
  try {
    const r = await prisma.runResult.findFirst({
      where: { testCase: { name: { contains: 'Edit Fields' } } },
      orderBy: { createdAt: 'desc' },
      include: { testCase: true }
    });
    if (!r) {
      console.log('No run result found.');
      return;
    }
    console.log('Run Result ID:', r.id);
    console.log('Test Case:', r.testCase?.name);
    console.log('Status:', r.status);
    console.log('Error Message:', r.errorMessage);

    if (r.journal) {
      const journal = JSON.parse(r.journal);
      console.log('\nTotal journal entries:', journal.length);
      journal.forEach((item, idx) => {
        console.log(`\n--- Entry [${idx}] (Role: ${item.observerRole}) ---`);
        console.log(JSON.stringify(item.payload || item, null, 2));
      });
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
})();
