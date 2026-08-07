'use strict';
const prisma = require('../server/prisma');
const caseContractV1 = require('../server/services/caseContractV1');

(async () => {
  try {
    const project = await prisma.project.findFirst({
      where: { name: { contains: 'letcode' } },
      include: { requirements: true },
    });

    const reqContent = project.requirements[0].content;
    const lines = reqContent.split(/\r?\n/);

    const scenarioRanges = caseContractV1._private.findScenarioRanges(lines);

    console.log(`Extracting Target URLs for ${scenarioRanges.length} scenarios...`);

    const scenarioUrlMap = {};

    scenarioRanges.forEach((sRange, idx) => {
      const sLines = lines.slice(sRange.start, sRange.end);
      let targetUrl = 'https://letcode.in/test';

      for (const line of sLines) {
        if (/^\s*Target URL\s*:/i.test(line)) {
          const urlMatch = line.match(/https?:\/\/[^\s]+/i);
          if (urlMatch) {
            targetUrl = urlMatch[0];
            break;
          }
        }
      }

      scenarioUrlMap[sRange.name] = targetUrl;
      console.log(`[Scenario ${idx + 1}] "${sRange.name}" -> Target URL: ${targetUrl}`);
    });

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
})();
