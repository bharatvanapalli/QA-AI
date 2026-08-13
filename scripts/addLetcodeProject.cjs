const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function addLetcodeProject() {
  const user = await prisma.user.findFirst();
  const org = await prisma.organization.findFirst();

  if (!user) {
    console.error('No user found in DB');
    return;
  }

  // Check if LetCode project already exists
  let letcodeProject = await prisma.project.findFirst({
    where: { name: 'LetCode_Practice' },
  });

  if (!letcodeProject) {
    letcodeProject = await prisma.project.create({
      data: {
        userId: user.id,
        orgId: org?.id || null,
        name: 'LetCode_Practice',
        targetUrl: 'https://letcode.in/forms',
        environment: 'staging',
        framework: 'playwright',
        aiProvider: 'copilot',
        autoAcceptDialogs: true,
      },
    });
    console.log('Created LetCode_Practice project:', letcodeProject.id);
  } else {
    console.log('LetCode_Practice project already exists:', letcodeProject.id);
  }

  // Get or Create a generation for LetCode_Practice
  let gen = await prisma.scenarioGeneration.findFirst({
    where: { projectId: letcodeProject.id },
  });

  if (!gen) {
    gen = await prisma.scenarioGeneration.create({
      data: {
        projectId: letcodeProject.id,
        label: 'LetCode Practice UI Automation Test Suite',
        version: 1,
        isCurrent: true,
      },
    });
  }

  // Check existing test cases
  const existingCount = await prisma.testCase.count({
    where: { projectId: letcodeProject.id },
  });

  if (existingCount === 0) {
    await prisma.testCase.createMany({
      data: [
        {
          projectId: letcodeProject.id,
          generationId: gen.id,
          name: 'Form Controls & Inputs Validation',
          type: 'ui_functional',
          module: 'Forms',
          status: 'approved',
          specCode: '// LetCode Form Controls Validation',
          confidence: 0.95,
          assertions: '[]',
        },
        {
          projectId: letcodeProject.id,
          generationId: gen.id,
          name: 'Native Dialogs & Alert Handling',
          type: 'ui_functional',
          module: 'Dialogs',
          status: 'approved',
          specCode: '// LetCode Dialog Flow',
          confidence: 0.95,
          assertions: '[]',
        },
      ],
    });
  }

  console.log('Successfully configured LetCode_Practice project and test cases!');
  await prisma.$disconnect();
}

addLetcodeProject().catch((err) => {
  console.error(err);
  process.exit(1);
});
