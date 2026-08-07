'use strict';
const playwright = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

(async () => {
  console.log('Testing browser launches on Windows OS...');

  // Test 1: Chrome with completely isolated temp profile dir
  const tempProfile1 = path.join(os.tmpdir(), `qaai-chrome-test-${Date.now()}`);
  fs.mkdirSync(tempProfile1, { recursive: true });

  try {
    console.log('\n--- Test 1: System Chrome with Isolated Profile Dir ---');
    const context1 = await playwright.chromium.launchPersistentContext(tempProfile1, {
      channel: 'chrome',
      headless: false,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--start-maximized',
      ],
    });
    console.log('SUCCESS: System Chrome with isolated profile launched successfully!');
    const page1 = await context1.newPage();
    await page1.goto('https://letcode.in/test');
    console.log('Page title:', await page1.title());
    await new Promise(r => setTimeout(r, 2000));
    await context1.close();
  } catch (err) {
    console.error('Test 1 failed:', err.message);
  }

  // Test 2: Edge (msedge) with isolated profile dir
  const tempProfile2 = path.join(os.tmpdir(), `qaai-edge-test-${Date.now()}`);
  fs.mkdirSync(tempProfile2, { recursive: true });

  try {
    console.log('\n--- Test 2: Microsoft Edge with Isolated Profile Dir ---');
    const context2 = await playwright.chromium.launchPersistentContext(tempProfile2, {
      channel: 'msedge',
      headless: false,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
      ],
    });
    console.log('SUCCESS: Microsoft Edge launched successfully!');
    const page2 = await context2.newPage();
    await page2.goto('https://letcode.in/test');
    console.log('Page title:', await page2.title());
    await new Promise(r => setTimeout(r, 2000));
    await context2.close();
  } catch (err) {
    console.error('Test 2 failed:', err.message);
  }
})();
