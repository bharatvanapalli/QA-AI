const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { launchMcpSession } = require('../server/services/sessionRegistry.js');

async function run() {
  const project = await prisma.project.findFirst();
  const session = await launchMcpSession({ project });
  try {
    const fn = `(el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }`;
    // Using a known element in letcode.in/edit? But this is not on that page.
    const res = await session.client.callTool({ name: 'browser_evaluate', arguments: { target: 'some-ref', element: 'Clear the text', function: fn } });
    console.log('Result:', JSON.stringify(res));
  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
}
run();
