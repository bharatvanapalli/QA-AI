'use strict';

const { chromium } = require('../server/node_modules/playwright');

(async () => {
  const port = Number(process.argv[2]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => !candidate.url().startsWith('about:')) || pages[0];
  const state = await page.evaluate(() => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const controls = Array.from(document.querySelectorAll('input, select, [role="combobox"]'))
      .filter(visible)
      .map((node) => {
        const container = node.closest('label, td, [class*="field"], [class*="form"], div');
        return {
          role: node.getAttribute('role') || node.tagName.toLowerCase(),
          name: clean(node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.name),
          context: clean(container?.innerText || '').slice(0, 120),
          value: clean(node.value || node.getAttribute('value') || node.textContent).slice(0, 120),
          expanded: node.getAttribute('aria-expanded'),
        };
      });
    const popup = Array.from(document.querySelectorAll('[role="listbox"], [role="dialog"], [role="grid"], [class*="overlay"], [class*="dropdown"]'))
      .filter(visible)
      .map((node) => ({ role: node.getAttribute('role'), text: clean(node.innerText).slice(0, 400) }))
      .slice(0, 4);
    return {
      title: document.title,
      heading: clean(document.querySelector('h1,h2')?.textContent || ''),
      controls,
      popup,
    };
  });
  if (process.argv.includes('--compact')) {
    const temporal = state.controls
      .filter((control) => /select date|select time|timezone|\d{2}\/\d{2}\/\d{4}|\d{2}:\d{2}|central/i.test(`${control.name} ${control.value}`))
      .map((control, index) => ({ index: index + 1, name: control.name, value: control.value, expanded: control.expanded }));
    const fields = state.controls
      .filter((control) => /pickup number|organization|equipment|inbound|outbound|collect|pre-paid/i.test(`${control.name} ${control.context} ${control.value}`))
      .map((control) => ({ name: control.name, value: control.value, expanded: control.expanded }));
    console.log(JSON.stringify({ url: page.url(), heading: state.heading, fields, temporal, popup: state.popup }, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify({ url: page.url(), ...state }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
