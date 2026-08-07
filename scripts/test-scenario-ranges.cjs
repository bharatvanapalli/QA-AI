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

    console.log(`=== SCENARIOS (${scenarioRanges.length}) & TEST CASES (${caseRanges.length}) ===`);

    const mappedScenarios = scenarioRanges.map((sRange) => {
      const casesInScenario = caseRanges.filter(cRange => cRange.start >= sRange.start && cRange.start < sRange.end);
      return {
        name: sRange.name,
        cases: casesInScenario.map(c => c.name),
      };
    });

    let totalCases = 0;
    mappedScenarios.forEach((s, idx) => {
      totalCases += s.cases.length;
      console.log(`\nScenario [${idx + 1}]: "${s.name}" (${s.cases.length} case(s))`);
      s.cases.forEach(cName => console.log(`   - ${cName}`));
    });

    console.log(`\nTOTAL VERIFIED: ${mappedScenarios.length} scenarios, ${totalCases} test cases.`);

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
})();
