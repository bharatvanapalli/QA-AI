const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();

const USER_ID = 'a5d916cd-4178-4bcc-b409-c885a389e843'; // bharatvanapalli8@gmail.com
const ORG_ID = 'org-a5d916cd-4178-4bcc-b409-c885a389e843';
const PROJECT_ID = 'c6a3a436-1c10-4462-9b61-f8b2ab71ebb0'; // original id, reused

const clickActionsSteps = [
  { order: 1, action: 'Navigate', value: 'https://letcode.in/button', authoredText: 'Navigate to https://letcode.in/button', check: null },
  { order: 2, action: 'Click', target: 'Goto Home button', authoredText: 'Click the "Goto Home" button.' },
  { order: 3, action: 'GoBack', authoredText: 'Navigate back to the Click Actions page.' },
  { order: 4, action: 'Click', target: 'Button Hold button', authoredText: 'Click and hold the "Button Hold" button until its status changes.' },
  { order: 5, action: 'Semantic', target: 'Find Location field', authoredText: 'Get the X & Y co-ordinates of "Find Location" field' },
  { order: 6, action: 'Semantic', target: 'What is my color? button', authoredText: 'Find the color of the button "What is my color?"' },
  { order: 7, action: 'Semantic', target: 'How tall & fat I am? button', authoredText: 'Find the height & width of the button "How tall & fat I am?"' },
  { order: 8, action: 'Verify', target: 'Disabled', value: 'Disabled', authoredText: 'Confirm button is disabled "Disabled"' },
  { order: 9, action: 'ClickAndHold', target: 'Button "Button Hold!"', authoredText: 'Click and Hold Button "Button Hold!"' },
];

const dialogFlowSteps = [
  { order: 1, action: 'Navigate', value: 'https://letcode.in/alert', authoredText: 'Navigate to "https://letcode.in/alert"' },
  { order: 2, action: 'Click', target: 'Simple Alert button', authoredText: 'Click "Simple Alert button"' },
  { order: 3, action: 'AssertText', target: 'alert text', value: 'Hey! Welcome to LetCode', authoredText: 'Verify that alert text contains "Hey! Welcome to LetCode".' },
  { order: 4, action: 'AcceptAlert', authoredText: 'Accept alert' },
  { order: 5, action: 'Click', target: 'Confirm Alert button', authoredText: 'Click "Confirm Alert button"' },
  { order: 6, action: 'AssertText', target: 'alert text', value: 'Are you happy with LetCode?', authoredText: 'Verify that alert text contains "Are you happy with LetCode?".' },
  { order: 7, action: 'AcceptAlert', authoredText: 'Accept alert' },
  { order: 8, action: 'AssertVisible', target: 'User selected: OK (True)', authoredText: 'Verify that "User selected: OK (True)" is visible.' },
  { order: 9, action: 'Click', target: 'Prompt Alert button', authoredText: 'Click "Prompt Alert button"' },
  { order: 10, action: 'AssertText', target: 'alert text', value: 'Enter your name', authoredText: 'Verify that alert text contains "Enter your name".' },
  { order: 11, action: 'Type', target: 'prompt', value: 'Bharat', authoredText: 'Type "Bharat" into prompt' },
  { order: 12, action: 'AcceptAlert', authoredText: 'Accept prompt' },
  { order: 13, action: 'AssertVisible', target: 'Your name is: Bharat', authoredText: 'Verify that "Your name is: Bharat" is visible.' },
  { order: 14, action: 'Click', target: 'Modern Alert button', authoredText: 'Click "Modern Alert button"' },
  { order: 15, action: 'AssertVisible', target: 'Modern Alert - Some people address me as sweet alert as well', authoredText: 'Verify that "Modern Alert - Some people address me as sweet alert as well" is visible.' },
  { order: 16, action: 'AssertVisible', target: 'Modern Alert modal', authoredText: 'Verify that "Modern Alert modal" is visible.' },
  { order: 17, action: 'Click', target: 'x inside Modern Alert modal', authoredText: 'Click "x" inside "Modern Alert modal"' },
];

// RECONSTRUCTED, NOT VERBATIM — see restore report. Steps 2,3,5,6,7,8 have
// confirmed target/value from live readback evidence; steps 1 and 4 and the
// exact check/expected phrasing are best-effort and flagged for the user to
// verify and correct via the Tests page editor.
const editFieldsSteps = [
  { order: 1, action: 'Navigate', value: 'https://letcode.in/edit', authoredText: 'Navigate to https://letcode.in/edit', _uncertain: false },
  { order: 2, action: 'Fill', target: 'Enter your full Name', value: 'Ada Lovelace', authoredText: '[RECONSTRUCTED — VERIFY WORDING] Fill "Enter your full Name" with "Ada Lovelace".', _uncertain: 'wording' },
  { order: 3, action: 'Fill', target: 'Append a text and press keyboard tab', value: 'I am good and I enjoy automation', authoredText: '[RECONSTRUCTED — VERIFY WORDING] Append "I am good and I enjoy automation" to "Append a text and press keyboard tab".', _uncertain: 'wording' },
  { order: 4, action: 'UNKNOWN', authoredText: '[MISSING — step 4 content could not be recovered, please re-author]', _uncertain: 'missing' },
  { order: 5, action: 'Fill', target: 'Clear the text', value: '', authoredText: '[RECONSTRUCTED — VERIFY WORDING] Clear "Clear the text" field.', _uncertain: 'wording' },
  { order: 6, action: 'Verify', target: 'What is inside the text box', authoredText: '[RECONSTRUCTED — VERIFY WORDING] Verify what is inside the text box.', _uncertain: 'wording' },
  { order: 7, action: 'Verify', target: 'Confirm edit field is disabled', authoredText: '[RECONSTRUCTED — VERIFY WORDING] Verify that "Confirm edit field is disabled" is disabled.', _uncertain: 'wording' },
  { order: 8, action: 'Verify', target: 'Confirm text is readonly', authoredText: '[RECONSTRUCTED — VERIFY WORDING] Verify that "Confirm text is readonly" is read-only.', _uncertain: 'wording' },
];

function caseShape({ name, module, steps, assertions, specCodeComment }) {
  return {
    projectId: PROJECT_ID,
    name,
    type: 'ui_functional',
    module,
    confidence: 80,
    status: 'approved',
    assertions: JSON.stringify(assertions),
    steps: JSON.stringify(steps),
    specCode: specCodeComment,
    businessRisk: 'P1',
    automatability: 'automatable',
    readinessStatus: 'ready',
    approvalEligibility: 'eligible',
    runEligibility: 'ready',
    sessionMode: 'fresh',
    producesStateJson: '[]',
    requiresStateJson: '[]',
    failurePolicy: 'continue_independent',
  };
}

async function main() {
  const existing = await prisma.project.findUnique({ where: { id: PROJECT_ID } });
  if (existing) {
    console.log('Project already exists, aborting to avoid overwrite:', existing.name);
    return;
  }
  await prisma.project.create({
    data: {
      id: PROJECT_ID,
      userId: USER_ID,
      orgId: ORG_ID,
      name: 'letcode',
      environment: 'staging',
      framework: 'playwright',
      targetUrl: 'https://letcode.in',
      aiProvider: 'claude',
      execMode: 'fast',
      enterpriseMode: false,
      contextIgnoreHttpsErrors: false,
      autoAcceptDialogs: false, // confirmed via direct query earlier this session
      triggerConfigJson: JSON.stringify({ contextHeadless: false }), // confirmed via direct query earlier this session
    },
  });
  console.log('Project "letcode" recreated with id', PROJECT_ID);

  const clickActions = await prisma.testCase.create({
    data: caseShape({
      name: 'Click Actions End-to-End Flow',
      module: 'LetCode Suite',
      steps: clickActionsSteps,
      assertions: clickActionsSteps.filter((s) => ['Verify', 'AssertVisible', 'AssertText'].includes(s.action)).map((s) => s.authoredText),
      specCodeComment: '// RESTORED VERBATIM from this session\'s own confirmed live tool output (2026-08-14 recovery).',
    }),
  });
  console.log('Restored: Click Actions End-to-End Flow ->', clickActions.id);

  const dialogFlow = await prisma.testCase.create({
    data: caseShape({
      name: 'LetCode Dialog Flow',
      module: 'LetCode Suite',
      steps: dialogFlowSteps,
      assertions: dialogFlowSteps.filter((s) => ['Verify', 'AssertVisible', 'AssertText'].includes(s.action)).map((s) => s.authoredText),
      specCodeComment: '// RESTORED VERBATIM from this session\'s own confirmed live tool output (2026-08-14 recovery).',
    }),
  });
  console.log('Restored: LetCode Dialog Flow ->', dialogFlow.id);

  const editFields = await prisma.testCase.create({
    data: caseShape({
      name: 'Edit Fields End-to-End Flow',
      module: 'LetCode Suite',
      steps: editFieldsSteps,
      assertions: editFieldsSteps.filter((s) => s.action === 'Verify').map((s) => s.authoredText),
      specCodeComment: '// PARTIALLY RECONSTRUCTED (2026-08-14 recovery) — steps 2,3,5,6,7,8 have confirmed target/value from live evidence; exact original wording and step 4 could not be recovered. REVIEW REQUIRED.',
    }),
  });
  console.log('Restored (PARTIAL, needs review): Edit Fields End-to-End Flow ->', editFields.id);

  console.log('\nDone. 3 of an unknown total number of original test cases restored.');
  console.log('If "letcode" had MORE test cases beyond these 3, their data is not recoverable from this session and is genuinely lost.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
