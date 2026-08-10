const { chromium } = require('playwright');
(async () => {
  for (const v of ['1217', '1223', '1224', '1228']) {
    const exe = 'C:/Users/2461898/AppData/Local/ms-playwright/chromium-' + v + '/chrome-win64/chrome.exe';
    try {
      const ctx = await chromium.launchPersistentContext(
        'C:/Users/2461898/AppData/Local/Temp/chromium-test-' + v,
        { headless: false, executablePath: exe, args: ['--no-sandbox'] }
      );
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('https://example.com', { timeout: 8000 });
      const title = await page.title();
      console.log('SUCCESS ' + v + ': headed launch + navigate OK, title="' + title + '"');
      await ctx.close();
    } catch (err) {
      console.log('FAILED ' + v + ': ' + err.message.split('\n')[0]);
    }
  }
})();
