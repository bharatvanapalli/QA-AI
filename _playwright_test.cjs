const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://letcode.in/edit');
  const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
  function printNode(node, indent = '') {
    console.log(`${indent}- ${node.role} "${node.name}"${node.value ? ' : ' + node.value : ''}`);
    for (const child of node.children || []) printNode(child, indent + '  ');
  }
  printNode(snapshot);
  await browser.close();
})();
