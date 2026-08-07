'use strict';
/*
 * Guard for B-2d.2a — CDP / action-time precision sidecar.
 * Proves: the DOM-atlas + telemetry init scripts are valid JS; the telemetry
 * listener is SAFE (capture+passive, never preventDefault/stopPropagation, ring
 * buffer, try/catch); atlas entries -> cascade evidence (gold/silver/bronze);
 * the sidecar runs over browser_evaluate and degrades gracefully (cdpAvailable
 * false + gaps). SYNTHETIC fake mcp; live capture proven at B-2e.
 */
const { DOM_ATLAS_FN, TELEMETRY_INIT_SCRIPT, ELEMENT_FROM_POINT_FN, atlasEntryToEvidence, createSidecar } = require('../server/services/cdpSidecar');
const { selectExportLocator } = require('../server/services/locatorEvidenceCascade');
const mcp = require('../server/services/mcp');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— scripts are valid JS functions —');
{
  let atlasFn = null; let telFn = null;
  try { atlasFn = eval('(' + DOM_ATLAS_FN + ')'); } catch (_) {}
  try { telFn = eval('(' + TELEMETRY_INIT_SCRIPT + ')'); } catch (_) {}
  ok('DOM_ATLAS_FN parses to a function', typeof atlasFn === 'function');
  ok('TELEMETRY_INIT_SCRIPT parses to a function', typeof telFn === 'function');
}

console.log('\n— telemetry listener SAFETY (never break the app) —');
{
  ok('uses capture phase', /capture:\s*true/.test(TELEMETRY_INIT_SCRIPT));
  ok('uses passive listeners', /passive:\s*true/.test(TELEMETRY_INIT_SCRIPT));
  ok('NEVER calls preventDefault', !/preventDefault/.test(TELEMETRY_INIT_SCRIPT));
  ok('NEVER calls stopPropagation', !/stopPropagation/.test(TELEMETRY_INIT_SCRIPT));
  ok('try/catch wrapped', /try\s*\{/.test(TELEMETRY_INIT_SCRIPT) && /catch/.test(TELEMETRY_INIT_SCRIPT));
  ok('bounded ring buffer (shift on overflow)', /\.shift\(\)/.test(TELEMETRY_INIT_SCRIPT));
  ok('captures composedPath', /composedPath/.test(TELEMETRY_INIT_SCRIPT));
}

console.log('\n— telemetry ROBUST capture (reinstallable; window+document; wide events; real target) —');
{
  ok('reinstallable / idempotent (returns already_installed)', /already_installed/.test(TELEMETRY_INIT_SCRIPT) && /__qaaiTelemetryInstalled/.test(TELEMETRY_INIT_SCRIPT));
  ok('attaches to BOTH window and document', /install\(window/.test(TELEMETRY_INIT_SCRIPT) && /install\(document/.test(TELEMETRY_INIT_SCRIPT));
  ok('listens to a wide event set (mousedown/keydown/focus/beforeinput)', /mousedown/.test(TELEMETRY_INIT_SCRIPT) && /keydown/.test(TELEMETRY_INIT_SCRIPT) && /focus/.test(TELEMETRY_INIT_SCRIPT) && /beforeinput/.test(TELEMETRY_INIT_SCRIPT));
  ok('uses composedPath()[0] as the REAL target (pierces shadow)', /path\[0\]/.test(TELEMETRY_INIT_SCRIPT));
  ok('best-effort same-origin frame install', /window\.frames/.test(TELEMETRY_INIT_SCRIPT));
}

console.log('\n— DOM atlas: generic RECORD model (table/grid/list/card) —');
{
  let atlasFn = null; try { atlasFn = eval('(' + DOM_ATLAS_FN + ')'); } catch (_) {}
  ok('atlas detects record roles (row/listitem/article/treeitem)', /RECORD_ROLE\s*=\s*\/\^\(row\|listitem\|article\|treeitem/.test(DOM_ATLAS_FN));
  ok('atlas climbs PAST cells to the row (cells are not records)', /CELL_ROLE/.test(DOM_ATLAS_FN) && /isCellish/.test(DOM_ATLAS_FN));
  ok('atlas prefers explicit record over repeated-sibling fallback', /explicit record with distinguishing text wins/.test(DOM_ATLAS_FN));
  ok('atlas detects repeated-sibling div-grid records (>=2 like siblings)', /sibs\.length\s*>=\s*2/.test(DOM_ATLAS_FN));
  ok('atlas detects display:table-row records', /display\s*===\s*'table-row'/.test(DOM_ATLAS_FN));
  ok('atlas attaches record identity to each action candidate', /record:\s*recordOf\(el\)/.test(DOM_ATLAS_FN));
  ok('atlas derives a stable in-record action selector', /actionSelector:\s*actionSelectorFor\(el\)/.test(DOM_ATLAS_FN));
  ok('atlas captures the nearest scroll container (virtualized rows)', /scrollContainer:\s*scrollContainerOf\(el\)/.test(DOM_ATLAS_FN));
  ok('record selector is structural (never blind div/li/tr soup)', !/'div, li, tr'/.test(DOM_ATLAS_FN));
}

console.log('\n— ELEMENT_FROM_POINT_FN: obscured-target check (overlay/modal/spinner) —');
{
  let fn = null; try { fn = eval('(' + ELEMENT_FROM_POINT_FN + ')'); } catch (_) {}
  ok('ELEMENT_FROM_POINT_FN parses to a function', typeof fn === 'function');
  ok('uses elementFromPoint', /elementFromPoint/.test(ELEMENT_FROM_POINT_FN));
  ok('pierces open shadow roots', /shadowRoot/.test(ELEMENT_FROM_POINT_FN));
  ok('returns onTarget + obscured', /onTarget/.test(ELEMENT_FROM_POINT_FN) && /obscured/.test(ELEMENT_FROM_POINT_FN));
  ok('no point -> ok:false (never crashes)', /no-point/.test(ELEMENT_FROM_POINT_FN));
}

console.log('\n— atlas entry -> cascade evidence (gold/silver/bronze) —');
{
  const gold = atlasEntryToEvidence({ role: 'button', name: 'Login', testId: 'loginBtn', bbox: { x: 1, y: 1, w: 2, h: 2 } });
  ok('role+name+testId -> gold exportable', selectExportLocator(gold) && selectExportLocator(gold).tier === 'gold');
  const silver = atlasEntryToEvidence({ role: 'generic', name: '', idAttr: 'user', bbox: { x: 1, y: 1, w: 2, h: 2 } });
  ok('id-only -> silver exportable', selectExportLocator(silver) && selectExportLocator(silver).tier === 'silver');
  const bronze = atlasEntryToEvidence({ role: 'generic', name: '', bbox: { x: 5, y: 6, w: 7, h: 8 }, surroundingText: 'thing' });
  ok('bbox-only -> bronze, NOT exportable', bronze.tier === 'bronze' && selectExportLocator(bronze) === null);
}

console.log('\n— sidecar over browser_evaluate (fake mcp) + graceful CDP degradation —');
{
  const atlas = [{ role: 'button', name: 'Login', idAttr: 'login', bbox: { x: 0, y: 0, w: 10, h: 10 } }];
  const fakeMcp = {
    textOfContent: mcp.textOfContent,
    parseEvaluateReturnValue: mcp.parseEvaluateReturnValue,
    callTool: async (s, tool, args) => {
      const fn = args.function || '';
      // Order matters: the install script also contains "__qaaiTelemetry || []",
      // so match the install marker FIRST, then the exact getRecentEvents reader.
      if (/__qaaiTelemetryInstalled/.test(fn)) return { content: [{ type: 'text', text: '### Result\n"installed"' }] };
      if (/^\(\)\s*=>\s*\(window\.__qaaiTelemetry/.test(fn.trim())) return { content: [{ type: 'text', text: '### Result\n' + JSON.stringify([{ type: 'click', tag: 'button', idAttr: 'login' }]) }] };
      if (/elementFromPoint/.test(fn)) return { content: [{ type: 'text', text: '### Result\n' + JSON.stringify({ ok: true, hit: { tag: 'button', testId: 'loginBtn' }, onTarget: true, obscured: false }) }] };
      return { content: [{ type: 'text', text: '### Result\n' + JSON.stringify(atlas) }] }; // atlas
    },
  };
  (async () => {
    const sc = createSidecar({ mcp: fakeMcp, session: {} });
    ok('cdpAvailable false by default (gaps recorded for B-2e)', sc.cdpAvailable === false);
    ok('precisionTelemetryGaps lists backendNodeId', sc.precisionTelemetryGaps().includes('backendNodeId'));
    const got = await sc.captureAtlas();
    ok('captureAtlas parses the MCP envelope -> atlas array', Array.isArray(got) && got[0] && got[0].name === 'Login', JSON.stringify(got));
    ok('installTelemetry -> installed', (await sc.installTelemetry()) === 'installed');
    const evs = await sc.getRecentEvents();
    ok('getRecentEvents -> array', Array.isArray(evs) && evs[0] && evs[0].type === 'click', JSON.stringify(evs));
    const hit = await sc.elementAtPoint(50, 60, { testId: 'loginBtn' });
    ok('elementAtPoint -> reliable pre-dispatch identity (onTarget, not obscured)', hit && hit.ok === true && hit.onTarget === true && hit.obscured === false, JSON.stringify(hit));

    console.log('');
    if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
    console.log('OK — CDP sidecar verified (SYNTHETIC; live capture + real CDP attach proven at B-2e)');
  })();
}
