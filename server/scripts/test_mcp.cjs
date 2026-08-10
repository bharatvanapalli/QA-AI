const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { launchMcpSession } = require('../server/services/sessionRegistry.js');

async function run() {
  const project = await prisma.project.findFirst();
  const session = await launchMcpSession({ project });
  try {
    const res = await session.client.callTool({ name: 'browser_fill', arguments: { target: 123, text: '' } });
    console.log('Result:', JSON.stringify(res));
  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
}
run();
