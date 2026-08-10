const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { triggerRun } = require('./server/services/runs.js'); // check if it exists

async function main() {
  const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';
  const CASE_ID = '4af44607-e59b-4cd4-85a2-68dc1e89cdc9';
  const USER_ID = 'a5d916cd-4178-4bcc-b409-c885a389e843';
  const ORG_ID = 'org-a5d916cd-4178-4bcc-b409-c885a389e843';
  
  // Try to find the service function to trigger a run
  const runsService = require('./server/services/runs');
  if (runsService.triggerRun) {
    const run = await runsService.triggerRun({
      projectId: PROJECT_ID,
      caseIds: [CASE_ID],
      userId: USER_ID,
      orgId: ORG_ID
    });
    console.log('Run triggered:', run.id);
  } else {
    console.error('triggerRun not found');
  }
}
main().finally(() => prisma.$disconnect());
