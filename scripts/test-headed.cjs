'use strict';
const pw = require('playwright');
const path = require('path');
const os = require('os');

(async () => {
  console.log('Testing installed system Chrome channel launch...');
  const profileDir = path.join(os.tmpdir(), 'qaai-test-system-chrome-' + Date.now());
  try {
    const context = await pw.chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
    });
    console.log('SUCCESS: System Chrome launched! Context pages:', context.pages().length);
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://example.com');
    console.log('Navigated to example.com successfully');
    await new Promise((r) => setTimeout(r, 3000));
    await context.close();
    console.log('Test complete');
  } catch (err) {
    console.error('System Chrome FAILED:', err.message);
    try {
      console.log('Testing installed Edge channel launch...');
      const contextEdge = await pw.chromium.launchPersistentContext(profileDir, {
        channel: 'msedge',
        headless: false,
      });
      console.log('SUCCESS: System Edge launched!');
      await new Promise((r) => setTimeout(r, 3000));
      await contextEdge.close();
    } catch (err2) {
      console.error('System Edge FAILED:', err2.message);
    }
  }
})();
