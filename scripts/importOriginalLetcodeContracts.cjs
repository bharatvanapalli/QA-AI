const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Deep contract extraction logic
function extractContractsFromRuntime() {
  const raw = fs.readFileSync('.qaai-runtime/scenario-generation-jobs.json', 'utf8');
  const data = JSON.parse(raw);

  const contracts = [];

  function findContracts(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.caseContractV1 && obj.caseContractV1.steps) {
      contracts.push(obj.caseContractV1);
    } else if (obj.steps && Array.isArray(obj.steps) && obj.steps.length > 0 && (obj.steps[0].authoredText || obj.steps[0].text)) {
      contracts.push(obj);
    }

    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'string' && (k === 'qualityContractJson' || obj[k].includes('caseContractV1'))) {
        try {
          const parsed = JSON.parse(obj[k]);
          findContracts(parsed);
        } catch (e) {}
      } else if (typeof obj[k] === 'object') {
        findContracts(obj[k]);
      }
    }
  }

  findContracts(data);

  const uniqueMap = new Map();
  for (const c of contracts) {
    const key = c.name || c.intent || (c.steps[0] && (c.steps[0].authoredText || c.steps[0].text));
    if (key && !uniqueMap.has(key)) {
      uniqueMap.set(key, c);
    }
  }

  return Array.from(uniqueMap.values());
}

async function importOriginalLetcodeContracts() {
  console.log('Extracting original 64 LetCode case contracts from runtime telemetry...');
  const contracts = extractContractsFromRuntime();
  console.log(`Found ${contracts.length} unique original LetCode case contracts.`);

  const user = await prisma.user.findFirst({ where: { email: 'bharatvanapalli8@gmail.com' } });
  let project = await prisma.project.findFirst({ where: { name: 'LetCode_Practice' } });

  if (!project) {
    project = await prisma.project.create({
      data: {
        userId: user.id,
        orgId: user.currentOrgId,
        name: 'LetCode_Practice',
        targetUrl: 'https://letcode.in/forms',
        environment: 'staging',
        framework: 'playwright',
        aiProvider: 'copilot',
        autoAcceptDialogs: true,
      },
    });
  }

  // Ensure Requirement
  let req = await prisma.requirement.findFirst({ where: { projectId: project.id } });
  if (!req) {
    req = await prisma.requirement.create({
      data: {
        projectId: project.id,
        title: 'LetCode Automation Practice Requirements',
        content: 'Master specification for LetCode practice site covering Forms, Input Controls, Buttons, Dialogs, Select Dropdowns, Tables, Windows, Frames, and File Uploads.',
        sourceType: 'manual',
      },
    });
  }

  // Ensure ScenarioGeneration
  let gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: project.id } });
  if (!gen) {
    gen = await prisma.scenarioGeneration.create({
      data: {
        id: 'gen-letcode-original-contracts-v1',
        projectId: project.id,
        label: 'LetCode Practice Original Contract Suite',
        version: 1,
        isCurrent: true,
      },
    });
  } else {
    await prisma.scenarioGeneration.update({
      where: { id: gen.id },
      data: { isCurrent: true },
    });
  }

  // Wipe temporary cases and recreate with ORIGINAL contracts
  await prisma.testCase.deleteMany({ where: { projectId: project.id } });
  await prisma.testScenario.deleteMany({ where: { projectId: project.id } });

  console.log('Populating ORIGINAL case contracts into database...');

  let importedCount = 0;
  for (let i = 0; i < contracts.length; i++) {
    const c = contracts[i];
    const caseName = c.name || c.intent || `LetCode Practice Test Case ${i + 1}`;
    const scenarioName = c.intent || c.name || `LetCode Scenario ${i + 1}`;

    // Format steps into UI JSON array
    const formattedSteps = (c.steps || []).map((s, idx) => ({
      order: idx + 1,
      action: s.type || s.action || 'Interact',
      target: s.element || s.target || 'Element',
      text: s.authoredText || s.text || s.action,
      expected: s.expected || s.operationCheck?.expected || 'Step completed',
      value: s.value || s.valueRef || '',
    }));

    // Format assertions into UI JSON array
    const formattedAssertions = (c.assertions || []).map(a => typeof a === 'string' ? a : (a.text || a.expected || a.type));

    const sc = await prisma.testScenario.create({
      data: {
        projectId: project.id,
        generationId: gen.id,
        name: scenarioName,
        rationale: c.intent || c.expectedFinalState?.description || 'Original authored test intent from user requirement',
        category: 'core',
        module: c.module || 'LetCode Suite',
        priority: 'P1',
      },
    });

    await prisma.testCase.create({
      data: {
        projectId: project.id,
        generationId: gen.id,
        scenarioId: sc.id,
        name: caseName,
        type: 'ui_functional',
        module: c.module || 'LetCode Suite',
        status: 'approved',
        confidence: 95,
        assertions: JSON.stringify(formattedAssertions),
        steps: JSON.stringify(formattedSteps),
        specCode: c.specCode || `// Original Case Contract: ${caseName}\n// Authored steps:\n${formattedSteps.map(s => `// Step ${s.order}: ${s.text}`).join('\n')}`,
      },
    });
    importedCount++;
  }

  console.log(`\nSUCCESS! Imported all ${importedCount} ORIGINAL LetCode case contracts with full authored steps into database!`);

  // Ensure all projects belong to user
  await prisma.project.updateMany({
    data: {
      userId: user.id,
      orgId: user.currentOrgId,
    },
  });

  await prisma.$disconnect();
}

importOriginalLetcodeContracts().catch((err) => {
  console.error(err);
  process.exit(1);
});
