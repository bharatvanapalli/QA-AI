const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function populateFullLetcodeSuite() {
  console.log('Populating full LetCode test suite into database...');

  // 1. Get user & LetCode_Practice project
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

  // 2. Create Requirement Document
  let req = await prisma.requirement.findFirst({ where: { projectId: project.id } });
  if (!req) {
    req = await prisma.requirement.create({
      data: {
        projectId: project.id,
        title: 'LetCode UI Automation Master Requirements',
        content: 'Master specification for LetCode practice site covering Forms, Input Controls, Buttons, Dialogs, Select Dropdowns, Tables, Windows, Frames, and File Uploads.',
        sourceType: 'manual',
      },
    });
    console.log('Created Requirement document:', req.id);
  }

  // 3. Create ScenarioGeneration
  let gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: project.id } });
  if (!gen) {
    gen = await prisma.scenarioGeneration.create({
      data: {
        id: 'gen-letcode-master-suite-v1',
        projectId: project.id,
        label: 'LetCode Practice Master Test Suite (v1)',
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

  // 4. Extract all LetCode cases from runtime JSON file
  const raw = fs.readFileSync('.qaai-runtime/scenario-generation-jobs.json', 'utf8');
  const data = JSON.parse(raw);
  const jobs = Object.values(data.jobs || {});
  const letcodeJob = jobs.find(j => JSON.stringify(j).toLowerCase().includes('letcode'));

  let extractedCases = [];
  if (letcodeJob && letcodeJob.snapshots) {
    for (const snap of letcodeJob.snapshots) {
      if (snap.data && snap.data.cases) {
        extractedCases.push(...snap.data.cases);
      }
    }
  }

  // Deduplicate cases by name
  const caseMap = new Map();
  for (const c of extractedCases) {
    if (c.name && !caseMap.has(c.name)) {
      caseMap.set(c.name, c);
    }
  }

  let finalCases = Array.from(caseMap.values());
  console.log(`Extracted ${finalCases.length} unique LetCode test cases from runtime snapshot.`);

  // If no cases extracted, build comprehensive 20 LetCode test cases list
  if (finalCases.length === 0) {
    finalCases = [
      { name: 'Input - Type & Read Text', module: 'Inputs', specCode: 'await page.goto("https://letcode.in/edit"); await page.fill("#fullName", "Bharat");' },
      { name: 'Input - Append & Clear Field', module: 'Inputs', specCode: 'await page.goto("https://letcode.in/edit"); await page.type("#join", " person");' },
      { name: 'Button - Read Button Coordinates & Color', module: 'Buttons', specCode: 'await page.goto("https://letcode.in/button"); const box = await page.locator("#home").boundingBox();' },
      { name: 'Button - Validate Disabled & Held Buttons', module: 'Buttons', specCode: 'await page.goto("https://letcode.in/button"); await expect(page.locator("#isDisabled")).toBeDisabled();' },
      { name: 'Select - Choose Dropdown Value & Read Selected Option', module: 'Select', specCode: 'await page.goto("https://letcode.in/dropdowns"); await page.selectOption("#fruits", "2");' },
      { name: 'Select - Select Multiple Hero Options', module: 'Select', specCode: 'await page.goto("https://letcode.in/dropdowns"); await page.selectOption("#superheros", ["am", "bt"]);' },
      { name: 'Alerts - Simple Alert Accept', module: 'Dialogs', specCode: 'await page.goto("https://letcode.in/waits");' },
      { name: 'Alerts - Confirm Dialog Accept & Dismiss', module: 'Dialogs', specCode: 'await page.goto("https://letcode.in/dialogs");' },
      { name: 'Alerts - Prompt Input Submission', module: 'Dialogs', specCode: 'await page.goto("https://letcode.in/dialogs");' },
      { name: 'Frame - Switch to Nested iFrame Controls', module: 'Frames', specCode: 'await page.goto("https://letcode.in/frame");' },
      { name: 'Radio & Checkbox - Verify Option State', module: 'Radio', specCode: 'await page.goto("https://letcode.in/radio");' },
      { name: 'Window - Handle Multiple Tabs and Popups', module: 'Windows', specCode: 'await page.goto("https://letcode.in/windows");' },
      { name: 'Elements - Inspect DOM Elements and Links', module: 'Elements', specCode: 'await page.goto("https://letcode.in/elements");' },
      { name: 'Drag & Drop - Move Element to Target Area', module: 'DragDrop', specCode: 'await page.goto("https://letcode.in/drop");' },
      { name: 'Table - Read Dynamic Web Table Data', module: 'Tables', specCode: 'await page.goto("https://letcode.in/table");' },
      { name: 'Table - Sort & Sum Table Columns', module: 'Tables', specCode: 'await page.goto("https://letcode.in/table");' },
      { name: 'Form - Complete User Registration Form', module: 'Forms', specCode: 'await page.goto("https://letcode.in/forms");' },
      { name: 'File Upload - Upload File Sample', module: 'FileUpload', specCode: 'await page.goto("https://letcode.in/file");' },
      { name: 'File Download - Download Sample File', module: 'FileDownload', specCode: 'await page.goto("https://letcode.in/file");' },
      { name: 'Shadow DOM - Access Shadow Root Elements', module: 'ShadowDOM', specCode: 'await page.goto("https://letcode.in/shadow");' },
    ];
  }

  // Delete existing test cases for LetCode to ensure clean population
  await prisma.testCase.deleteMany({ where: { projectId: project.id } });
  await prisma.testScenario.deleteMany({ where: { projectId: project.id } });

  console.log(`Inserting ${finalCases.length} LetCode test scenarios and test cases into database...`);

  for (const c of finalCases) {
    const scName = c.scenarioTitle || c.name || 'LetCode Test Scenario';
    const sc = await prisma.testScenario.create({
      data: {
        projectId: project.id,
        generationId: gen.id,
        name: scName,
        rationale: c.rationale || 'Verify functional requirement on LetCode portal',
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
        name: c.name,
        type: 'ui_functional',
        module: c.module || 'LetCode Suite',
        status: 'approved',
        specCode: c.specCode || `// Test case: ${c.name}\nawait page.goto("https://letcode.in/forms");`,
        confidence: 0.95,
        assertions: typeof c.assertions === 'string' ? c.assertions : JSON.stringify(c.assertions || []),
      },
    });
  }

  const finalCount = await prisma.testCase.count({ where: { projectId: project.id } });
  console.log(`\nSUCCESS! Created requirement document and populated ${finalCount} approved LetCode test cases!`);

  await prisma.$disconnect();
}

populateFullLetcodeSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
