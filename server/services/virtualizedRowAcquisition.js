'use strict';

/**
 * Virtualized / offscreen ROW ACQUISITION (Phase B-2e).
 *
 * Enterprise grids virtualize: the target row may not be in the DOM until it is
 * scrolled into view, filtered to, or searched for. This orchestrator finds the
 * intended record by its DISTINGUISHING TEXT (username/email/id/…) without ever
 * proving against a stale/unmounted row:
 *
 *   1. (optional) apply the page's own search/filter first (cheapest).
 *   2. capture the atlas; look for a record whose rowText/cellTexts contain the
 *      target text — prove ONLY against the currently rendered viewport.
 *   3. if absent, scroll the detected scroll container by one viewport,
 *      RECAPTURE the atlas (flush + replace — never append stale rows), repeat.
 *   4. stop when the row appears (then forge + prove record_action) or when
 *      scrolling makes no progress / maxScrolls is hit (honest "not found").
 *
 * GENERIC — no site classes. The browser side-effects (captureAtlas, scrollNext,
 * applyFilter) and the locator proof (buildPassport/buildProvenPassport/resolve)
 * are INJECTED, so the loop is deterministic and unit-tested offline; live wiring
 * happens in the conductor. Generated code uses the no-coordinate helpers below.
 */

function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

/** Does an atlas entry's record carry the target distinguishing text? */
function recordMatchesText(entry, targetText) {
  if (!entry || !entry.record) return false;
  const t = norm(targetText);
  if (!t) return false;
  if (norm(entry.record.rowText).includes(t)) return true;
  return (Array.isArray(entry.record.cellTexts) ? entry.record.cellTexts : []).some((c) => norm(c).includes(t));
}

/** Pick the intended ACTION entry inside the matched record. */
function selectActionEntry(matches, { actionName, actionSelector }) {
  if (!matches.length) return null;
  if (actionName) {
    const byName = matches.find((e) => norm(e.name) === norm(actionName) || norm(e.name).includes(norm(actionName)));
    if (byName) return byName;
  }
  if (actionSelector) {
    const byIcon = matches.find((e) => e.actionSelector === actionSelector);
    if (byIcon) return byIcon;
  }
  // else the first nameless icon, else the first action in the record
  return matches.find((e) => !e.name) || matches[0];
}

/**
 * @returns {Promise<{found,reason,scrollsUsed,flushedRows,record,actionEntry,passport}>}
 */
async function acquireRecord(opts = {}) {
  const {
    targetText, actionName = null, actionSelector = null,
    captureAtlas, scrollNext, applyFilter = null,
    buildPassport, buildProvenPassport, resolve,
    maxScrolls = 20, log = () => {},
  } = opts;
  if (!targetText) return { found: false, reason: 'no_target_text', scrollsUsed: 0, flushedRows: 0 };
  if (typeof captureAtlas !== 'function') return { found: false, reason: 'no_capture', scrollsUsed: 0, flushedRows: 0 };

  let flushedRows = 0;     // total rows discarded across recaptures (never proved against)
  let filterApplied = false;
  if (typeof applyFilter === 'function') {
    try { filterApplied = !!(await applyFilter(targetText)); } catch (_) { filterApplied = false; }
    if (filterApplied) log(`applied page filter for "${targetText}"`);
  }

  let prevScrollTop = null;
  let scrolls = 0;
  let stopReason = 'row_not_found_after_scroll';
  for (let i = 0; i <= maxScrolls; i++) {
    // FRESH capture each iteration — the previous atlas is discarded (flush).
    let atlas = [];
    try { atlas = await captureAtlas(); } catch (_) { atlas = []; }
    atlas = Array.isArray(atlas) ? atlas : [];

    const matches = atlas.filter((e) => recordMatchesText(e, targetText));
    if (matches.length) {
      const actionEntry = selectActionEntry(matches, { actionName, actionSelector });
      let passport = null;
      if (actionEntry && typeof buildPassport === 'function') {
        const cp = buildPassport({
          role: actionEntry.role, inputType: actionEntry.type, name: actionEntry.name,
          testId: actionEntry.testId, idAttr: actionEntry.idAttr, nameAttr: actionEntry.nameAttr,
          ancestors: actionEntry.ancestors || [], record: actionEntry.record || null,
          actionSelector: actionEntry.actionSelector || null, frame: actionEntry.frame || null,
        });
        if (typeof buildProvenPassport === 'function' && typeof resolve === 'function') {
          passport = await buildProvenPassport(cp, resolve);
        } else { passport = cp; }
      }
      return { found: true, reason: filterApplied ? 'matched_after_filter' : (i === 0 ? 'matched_immediately' : 'matched_after_scroll'), scrollsUsed: i, flushedRows, record: actionEntry ? actionEntry.record : matches[0].record, actionEntry: actionEntry || null, passport };
    }

    // not in the current viewport — count what we're flushing and scroll on.
    flushedRows += atlas.filter((e) => e.record).length;
    if (i === maxScrolls || typeof scrollNext !== 'function') { stopReason = i === maxScrolls ? 'max_scrolls_exhausted' : 'no_scroll_fn'; break; }
    let step = null;
    try { step = await scrollNext(); } catch (_) { step = null; }
    if (!step || step.scrolled === false || step.atBottom === true) { stopReason = 'reached_end_of_list'; log(`scroll stopped at iteration ${i} (no further scroll)`); break; }
    if (prevScrollTop != null && step.scrollTop != null && step.scrollTop === prevScrollTop) { stopReason = 'no_scroll_progress'; log('no scroll progress — stopping'); break; }
    prevScrollTop = step.scrollTop != null ? step.scrollTop : prevScrollTop;
    scrolls++;
    log(`scrolled (iteration ${i}); recapturing atlas`);
  }
  return { found: false, reason: stopReason, scrollsUsed: scrolls, flushedRows };
}

// Browser-eval: scroll a container (or window) by one viewport; report progress.
// Used by the conductor's scrollNext; reported scrollTop drives no-progress stop.
const SCROLL_STEP_FN = `(selector) => {
  try {
    const el = selector ? document.querySelector(selector) : null;
    if (el) {
      const before = el.scrollTop;
      el.scrollBy(0, Math.max(1, el.clientHeight - 40));
      const after = el.scrollTop;
      return { scrolled: after !== before, scrollTop: after, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, atBottom: after + el.clientHeight >= el.scrollHeight - 2 };
    }
    const before = window.scrollY;
    window.scrollBy(0, Math.max(1, window.innerHeight - 40));
    const after = window.scrollY;
    return { scrolled: after !== before, scrollTop: after, scrollHeight: document.body.scrollHeight, clientHeight: window.innerHeight, atBottom: after + window.innerHeight >= document.body.scrollHeight - 2 };
  } catch (e) { return { scrolled: false, error: String(e && e.message || e) }; }
}`;

// Codegen helpers (NO coordinates; row-text anchored; uniqueness asserted — never
// .first() as a substitute for proof). Emitted into the generated POM for Phase E.
const RECORD_HELPERS_SRC = `// QAAI virtualized-record helpers — row-text anchored, no coordinates.
async function qaaiFindRecord(page, opts) {
  const { recordSelector, recordRole, text, scrollSelector, maxScrolls = 20 } = opts;
  const records = () => (recordRole ? page.getByRole(recordRole) : page.locator(recordSelector)).filter({ hasText: text });
  for (let i = 0; i <= maxScrolls; i++) {
    const n = await records().count();
    if (n === 1) { const r = records().first(); await r.scrollIntoViewIfNeeded(); return r; }
    if (n > 1) throw new Error('QAAI: ambiguous record text (matched ' + n + '): ' + text);
    const sc = scrollSelector ? page.locator(scrollSelector) : null;
    const before = sc ? await sc.evaluate((e) => e.scrollTop) : await page.evaluate(() => window.scrollY);
    if (sc) await sc.evaluate((e) => e.scrollBy(0, e.clientHeight)); else await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(250);
    const after = sc ? await sc.evaluate((e) => e.scrollTop) : await page.evaluate(() => window.scrollY);
    if (after === before) break; // no progress
  }
  throw new Error('QAAI: record not found for text: ' + text);
}
async function qaaiClickRecordAction(page, opts) {
  const rec = await qaaiFindRecord(page, opts);
  const action = opts.actionName ? rec.getByRole(opts.actionRole || 'button', { name: opts.actionName }) : rec.locator(opts.actionSelector);
  if (await action.count() !== 1) throw new Error('QAAI: record action not unique for ' + (opts.actionName || opts.actionSelector));
  await action.click();
}`;

module.exports = { acquireRecord, recordMatchesText, selectActionEntry, SCROLL_STEP_FN, RECORD_HELPERS_SRC };
