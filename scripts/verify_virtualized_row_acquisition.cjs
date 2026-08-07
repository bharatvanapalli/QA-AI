'use strict';
/*
 * Guard for B-2e virtualized/offscreen ROW ACQUISITION. Proves the loop:
 * filter-first, scroll + RECAPTURE (flush stale rows — never proved against),
 * prove only the current viewport, stop on no-progress / maxScrolls, and forge
 * record_action for the found row. Browser side-effects + proof are injected
 * (deterministic offline). Also validates the no-coordinate codegen helpers.
 */
const V = require('../server/services/virtualizedRowAcquisition');
const { acquireRecord, recordMatchesText, selectActionEntry, SCROLL_STEP_FN, RECORD_HELPERS_SRC } = V;
const { buildPassport, buildProvenPassport } = require('../server/services/locatorPromotionEngine');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// A virtualized grid: the target row only mounts after 2 scrolls. Each "page" of
// rows is DISTINCT (simulating unmount/remount) so we can prove flush.
function rowEntry(rowText, cells) {
  return { role: 'button', name: '', tag: 'button', actionSelector: 'button:has(.bi-trash)', ancestors: [{ role: 'row', name: rowText }], record: { rowText, cellTexts: cells, recordSelector: '[role="row"]', containerRole: 'row', containerTag: 'div', siblingCount: 20 } };
}
const PAGES = [
  [rowEntry('Aaron a@x Admin Enabled', ['Aaron', 'a@x'])],
  [rowEntry('Bella b@x ESS Enabled', ['Bella', 'b@x'])],
  [rowEntry('Carlos carlos@x ESS Disabled', ['Carlos', 'carlos@x'])], // target mounts here
];
const resolve = async (c) => ({ count: 1, sameTarget: true, actionable: true, obscured: false, survivesRerender: true });

(async () => {
  console.log('— text matching against record identity —');
  ok('matches on rowText', recordMatchesText(rowEntry('Carlos carlos@x ESS', ['Carlos']), 'carlos@x') === true);
  ok('matches on a cell', recordMatchesText(rowEntry('x', ['Carlos', 'carlos@x']), 'Carlos') === true);
  ok('no match -> false', recordMatchesText(rowEntry('Aaron a@x', ['Aaron']), 'zzz') === false);

  console.log('\n— found-after-scroll + FLUSH (stale rows never proved) —');
  {
    let cur = 0; let scrolls = 0;
    const captureAtlas = async () => PAGES[Math.min(cur, PAGES.length - 1)];
    const scrollNext = async () => { cur++; scrolls++; return { scrolled: true, scrollTop: cur * 500, atBottom: cur >= PAGES.length - 1 ? false : false }; };
    const r = await acquireRecord({ targetText: 'carlos@x', actionSelector: 'button:has(.bi-trash)', captureAtlas, scrollNext, buildPassport, buildProvenPassport, resolve, maxScrolls: 10 });
    ok('found the offscreen row after scrolling', r.found === true && r.scrollsUsed === 2, JSON.stringify({ found: r.found, scrolls: r.scrollsUsed, reason: r.reason }));
    ok('flushed the 2 earlier non-matching rows (never proved)', r.flushedRows === 2, String(r.flushedRows));
    ok('forged + proved record_action for the found row', r.passport && r.passport.proven === true && r.passport.primary.strategy === 'record_action', r.passport && JSON.stringify({ proven: r.passport.proven, strat: r.passport.primary && r.passport.primary.strategy }));
    ok('proven locator is row-text anchored (filter hasText)', /filter\(\{ hasText: 'Carlos carlos@x ESS Disabled' \}\)/.test(r.passport.primary.expression), r.passport.primary.expression);
  }

  console.log('\n— filter-first short-circuits scrolling —');
  {
    const captureAtlas = async () => [rowEntry('Carlos carlos@x ESS Disabled', ['Carlos', 'carlos@x'])];
    let scrolled = 0; const scrollNext = async () => { scrolled++; return { scrolled: true, scrollTop: scrolled * 10 }; };
    const applyFilter = async () => true;
    const r = await acquireRecord({ targetText: 'carlos@x', actionSelector: 'button:has(.bi-trash)', captureAtlas, scrollNext, applyFilter, buildPassport, buildProvenPassport, resolve });
    ok('matched after filter, zero scrolls', r.found === true && r.reason === 'matched_after_filter' && scrolled === 0, JSON.stringify({ reason: r.reason, scrolled }));
  }

  console.log('\n— no-progress stop (never infinite-loops a stuck grid) —');
  {
    const captureAtlas = async () => [rowEntry('Zoe z@x', ['Zoe'])]; // target never present
    const scrollNext = async () => ({ scrolled: true, scrollTop: 999 }); // same scrollTop every time
    const r = await acquireRecord({ targetText: 'carlos@x', captureAtlas, scrollNext, buildPassport, buildProvenPassport, resolve, maxScrolls: 50 });
    ok('stopped on no scroll progress (not maxScrolls)', r.found === false && r.reason === 'no_scroll_progress' && r.scrollsUsed < 50, JSON.stringify({ found: r.found, reason: r.reason, scrolls: r.scrollsUsed }));
  }

  console.log('\n— scroll step fn + codegen helpers —');
  {
    let fn = null; try { fn = eval('(' + SCROLL_STEP_FN + ')'); } catch (_) {}
    ok('SCROLL_STEP_FN parses', typeof fn === 'function');
    ok('SCROLL_STEP_FN reports atBottom + scrollTop', /atBottom/.test(SCROLL_STEP_FN) && /scrollTop/.test(SCROLL_STEP_FN));
    ok('helpers parse as valid JS', (() => { try { new Function(RECORD_HELPERS_SRC + '\nreturn typeof qaaiFindRecord;')(); return true; } catch (e) { return false; } })());
    ok('helper asserts record uniqueness (no .first() as proof)', /ambiguous record text/.test(RECORD_HELPERS_SRC) && /n === 1/.test(RECORD_HELPERS_SRC));
    ok('helper action requires count === 1', /action\.count\(\) !== 1/.test(RECORD_HELPERS_SRC));
    ok('helpers use NO coordinates (no mouse.click x,y)', !/mouse\.click/.test(RECORD_HELPERS_SRC) && !/\bx:\s*\d/.test(RECORD_HELPERS_SRC));
    ok('helper stops on no scroll progress', /if \(after === before\) break/.test(RECORD_HELPERS_SRC));
  }

  console.log('');
  if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
  console.log('OK — Virtualized row acquisition verified (deterministic; live scroll proven at B-2e)');
})();
