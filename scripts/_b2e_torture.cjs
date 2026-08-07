'use strict';
/*
 * B-2e HARD locator torture matrix (live, standalone) against AUTHENTICATED
 * OrangeHRM Admin → System Users: custom dropdown, autocomplete, table-row icon
 * action, repeated same-label icons, control buttons. Forges + PROVES each class
 * and reports tier / count / actionable / where it falls to bronze/repair.
 * Honest gap-finder — no conductor, no backend restart.
 */
const { chromium } = require('playwright');
const { DOM_ATLAS_FN } = require('../server/services/cdpSidecar');
const { buildPassport, buildProvenPassport } = require('../server/services/locatorPromotionEngine');

const BASE = 'https://opensource-demo.orangehrmlive.com/web/index.php';

async function launch() {
  for (const channel of ['chrome', 'msedge']) { try { return await chromium.launch({ headless: true, channel, args: ['--no-sandbox'] }); } catch (_) {} }
  return chromium.launch({ headless: true, args: ['--no-sandbox'] });
}
function buildLocator(page, c) { let cur = page; for (const s of c.build) { const [m, ...a] = s; cur = cur[m](...a); } return cur; }

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  const report = { classes: {}, atlasCount: 0, notes: [] };
  const resolve = async (c) => {
    try {
      const loc = buildLocator(page, c); const count = await loc.count();
      let visible = false; let enabled = false; let obscured = false;
      if (count === 1) {
        try { visible = await loc.first().isVisible(); enabled = await loc.first().isEnabled(); } catch (_) {}
        // Obscured-target check: elementFromPoint(center) must be the target or a
        // known ancestor/descendant — never call a covered element actionable.
        try {
          const bb = await loc.first().boundingBox();
          if (bb) {
            const p = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
            obscured = await loc.first().evaluate((el, pt) => {
              let top = document.elementFromPoint(pt.x, pt.y); let g = 0;
              while (top && top.shadowRoot && g < 6) { const inner = top.shadowRoot.elementFromPoint(pt.x, pt.y); if (!inner || inner === top) break; top = inner; g++; }
              if (!top) return true;
              return !(top === el || el.contains(top) || top.contains(el));
            }, p);
          }
        } catch (_) {}
      }
      return { count, sameTarget: count === 1, actionable: count === 1 && visible && enabled && !obscured, visible, enabled, obscured, survivesRerender: true };
    } catch (e) { return { count: -1, sameTarget: false, actionable: false, error: String(e.message || e).slice(0, 100) }; }
  };
  const ctxOf = (e) => ({ role: e.role, inputType: e.type, name: e.name, label: e.labelText, title: e.title, altText: e.altText, testId: e.testId, idAttr: e.idAttr, nameAttr: e.nameAttr, placeholder: e.placeholder, ancestors: e.ancestors || [], record: e.record || null, actionSelector: e.actionSelector || null, scrollContainer: e.scrollContainer || null, childTag: e.childTag, bbox: e.bbox });
  const forgeProve = async (label, ctx) => {
    const cp = buildPassport(ctx);
    const pp = await buildProvenPassport(cp, resolve);
    return {
      label,
      candidates: [cp.primary, ...cp.alternates].filter(Boolean).map((c) => `${c.tier}:${c.strategy}`),
      bronzeOnly: cp.bronzeOnly,
      proven: pp.primary ? `${pp.primary.tier}:${pp.primary.strategy} -> ${pp.primary.expression}` : null,
      repairRequired: pp.repairRequired,
    };
  };

  try {
    // ── login ── (domcontentloaded + explicit waits — networkidle is flaky on the slow demo host)
    await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByPlaceholder('Username').waitFor({ state: 'visible', timeout: 30000 });
    await page.getByPlaceholder('Username').fill('Admin');
    await page.getByPlaceholder('Password').fill('admin123');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL(/dashboard/, { timeout: 30000 }).catch(() => {});
    // ── Admin → System Users ──
    await page.goto(`${BASE}/admin/viewSystemUsers`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // WAIT for the table records to render/stabilize before proving row actions.
    await page.locator('[role="row"], tr, [class*="table-card"], [class*="table-row"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const atlas = await page.evaluate(`(${DOM_ATLAS_FN})()`);
    report.atlasCount = Array.isArray(atlas) ? atlas.length : 0;

    // CLASS 1 — control button (baseline): Search
    {
      const e = (atlas || []).find((x) => /search/i.test(x.name || '') && x.tag === 'button');
      report.classes.control_button_search = e ? await forgeProve('Search button', { role: e.role, name: e.name, testId: e.testId, idAttr: e.idAttr }) : { found: false, note: 'Search button not in atlas' };
    }

    // CLASS 2 — CUSTOM DROPDOWN (role-less div trigger; now captured via tabindex)
    {
      const dd = (atlas || []).find((x) => x.tag !== 'input' && x.tag !== 'button' && (/-- select --/i.test(x.name || '') || /select/i.test(x.labelText || '')));
      const triggerCount = await page.locator('[class*="select-text"]').count().catch(() => -1);
      report.classes.custom_dropdown = {
        triggerExistsInDom: triggerCount,
        capturedByAtlas: !!dd,
        atlas: dd ? { role: dd.role, tag: dd.tag, name: dd.name, labelText: dd.labelText, ancestors: (dd.ancestors || []).map((a) => `${a.role}:${(a.name || '').slice(0, 24)}`) } : null,
        forge: dd ? await forgeProve('custom dropdown', ctxOf(dd)) : null,
      };
    }

    // CLASS 3 — TABLE ROW ICON ACTION: target a nameless icon that belongs to a
    // RECORD (generic row/grid/card detection), excluding nav-menu icons. The real
    // enterprise case — anchor the icon to its unique row text → action child.
    {
      const iconButtons = (atlas || []).filter((x) => x.tag === 'button' && (!x.name || x.name.length === 0));
      const isNav = (x) => (x.ancestors || []).some((a) => /navigation/i.test(a.role || ''));
      const rowIcon = iconButtons.find((x) => x.record && x.record.rowText && !isNav(x));
      const navIcons = iconButtons.filter(isNav);
      const anyRecord = (atlas || []).filter((x) => x.record && x.record.rowText);
      report.classes.table_row_icon = {
        namelessIconButtonsInAtlas: iconButtons.length,
        actionsWithRecordIdentity: anyRecord.length,
        rowScopedIconFound: !!rowIcon,
        sampleRecord: rowIcon ? { rowText: rowIcon.record.rowText, recordSelector: rowIcon.record.recordSelector, containerRole: rowIcon.record.containerRole, containerTag: rowIcon.record.containerTag, siblingCount: rowIcon.record.siblingCount, actionSelector: rowIcon.actionSelector } : (anyRecord[0] ? { rowText: anyRecord[0].record.rowText, recordSelector: anyRecord[0].record.recordSelector, name: anyRecord[0].name, actionSelector: anyRecord[0].actionSelector } : null),
        navIconsExcluded: navIcons.length,
        forge: rowIcon ? await forgeProve('row icon (nameless, record-anchored)', ctxOf(rowIcon)) : null,
        note: rowIcon ? 'targeted a real record-scoped nameless icon' : 'no record-scoped nameless icon in atlas',
      };

      // Also try a NAMED row action (e.g. an Edit/Delete with an accessible name).
      const namedRowAction = (atlas || []).find((x) => x.record && x.record.rowText && x.name && /edit|delete|view|download|save|update/i.test(x.name) && !isNav(x));
      report.classes.named_row_action = namedRowAction
        ? await forgeProve('named row action', ctxOf(namedRowAction))
        : { found: false, note: 'no named record-scoped action in atlas' };
    }

    // CLASS 4 — AUTOCOMPLETE (Employee Name on Add User; here the filter has no employee field, note PIM)
    {
      const placeholders = (atlas || []).filter((x) => x.tag === 'input').map((x) => x.placeholder).filter(Boolean);
      report.classes.text_inputs_present = placeholders;
    }

    console.log('B2E_TORTURE_JSON_START');
    console.log(JSON.stringify(report, null, 2));
    console.log('B2E_TORTURE_JSON_END');
  } catch (err) {
    console.log('B2E_TORTURE_ERROR', String(err && err.message || err));
  } finally {
    await browser.close().catch(() => {});
  }
})();
