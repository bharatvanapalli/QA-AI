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
    const caseRanges = caseContractV1._private.findCaseRanges(lines, scenarioRanges);

    console.log(`Analyzing ${caseRanges.length} cases in user flow document...`);

    let totalSteps = 0;
    let totalAssertions = 0;

    caseRanges.slice(0, 5).forEach((cRange, idx) => {
      const caseLines = lines.slice(cRange.start, cRange.end);
      const text = caseLines.join('\n');

      // Extract step lines (lines starting with dash, bullet, or number)
      const rawStepLines = caseLines.filter(line => /^\s*[-*•\d+.]+\s+/.test(line));
      // Extract assertion/expected lines
      const rawAssertionLines = caseLines.filter(line => /\b(verify|assert|should|expect|confirm|validate|check)\b/i.test(line));

      console.log(`\nCase [${idx + 1}]: "${cRange.name}"`);
      console.log(`   Lines count: ${caseLines.length}`);
      console.log(`   Extracted step lines: ${rawStepLines.length}`);
      console.log(`   Extracted assertion lines: ${rawAssertionLines.length}`);

      rawStepLines.slice(0, 3).forEach(s => console.log(`      -> Step: ${s.trim()}`));
      rawAssertionLines.slice(0, 2).forEach(a => console.log(`      => Assertion: ${a.trim()}`));
    });

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
})();
