const { spawn } = require('child_process');
const mcp = spawn('npx.cmd', ['@playwright/mcp']);

mcp.stdout.on('data', (data) => {
  const messages = data.toString().split('\n').filter(Boolean);
  for (const msgStr of messages) {
    try {
      const msg = JSON.parse(msgStr);
      if (msg.id === 1) {
        const evalTool = msg.result.tools.find(t => t.name === 'browser_evaluate');
        console.log(JSON.stringify(evalTool.inputSchema, null, 2));
        process.exit(0);
      }
    } catch(e) {}
  }
});

mcp.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list"
}) + '\n');
