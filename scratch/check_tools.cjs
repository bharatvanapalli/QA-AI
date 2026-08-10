const mcp = require('../server/services/mcp');

async function run() {
  const session = await mcp.startMcpSession({ project: { id: 'test' } });
  try {
    const res = await session.client.listTools();
    console.log(res.tools.map(t => t.name).join('\n'));
    const evalTool = res.tools.find(t => t.name === 'browser_evaluate' || t.name === 'evaluate');
    if (evalTool) {
      console.log('Eval schema:', JSON.stringify(evalTool.inputSchema, null, 2));
    }
  } finally {
    process.exit(0);
  }
}
run().catch(console.error);
