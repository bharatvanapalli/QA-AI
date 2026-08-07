'use strict';
const { launchLiveCdpBrowser } = require('../server/services/mcp');

(async () => {
  console.log('Testing launchLiveCdpBrowser in server/services/mcp.js...');
  try {
    const res = await launchLiveCdpBrowser({
      sessionId: `test-session-${Date.now()}`,
      project: { contextHeadless: false },
    });
    console.log('SUCCESS: Browser launched with endpoint:', res.endpoint);
    console.log('Profile dir used:', res.profileDir);
    const page = res.context.pages()[0] || await res.context.newPage();
    await page.goto('https://letcode.in/test');
    console.log('Opened page:', await page.title());
    await new Promise(r => setTimeout(r, 3000));
    await res.context.close();
    console.log('Closed test browser cleanly.');
  } catch (err) {
    console.error('Launch failed:', err);
  }
})();
