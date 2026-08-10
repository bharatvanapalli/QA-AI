const { Client, StdioClientTransport } = require('@modelcontextprotocol/sdk/client/index.js');
async function test() {
  console.log("Loading SDK...");
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.75']
  });
  const client = new Client({ name: 'test', version: '1.0' });
  await client.connect(transport);
  console.log("Connected.");
  const res = await client.listTools();
  const evaluateTool = res.tools.find(t => t.name === 'browser_evaluate');
  console.log("browser_evaluate schema:", JSON.stringify(evaluateTool.inputSchema, null, 2));
  process.exit(0);
}
test().catch(console.error);
