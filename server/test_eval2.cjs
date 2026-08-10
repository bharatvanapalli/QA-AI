const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const { launchMcpSession } = require('./services/sessionRegistry.js');
  const project = await prisma.project.findFirst();
  const session = await launchMcpSession({ project });
  try {
    const res = await session.client.listTools();
    const evaluateTool = res.tools.find(t => t.name === 'browser_evaluate');
    console.log('browser_evaluate schema:', JSON.stringify(evaluateTool.inputSchema));
  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
}
run();
