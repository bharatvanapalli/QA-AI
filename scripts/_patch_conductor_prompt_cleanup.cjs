const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'server', 'services', 'agents', 'conductor.js');
const outputPath = path.join(root, '_conductor_prompt_cleanup.tmp.js');
let source = fs.readFileSync(sourcePath, 'utf8');

function replaceOnce(from, to, label) {
  const windowsFrom = from.replace(/\n/g, '\r\n');
  const windowsTo = to.replace(/\n/g, '\r\n');
  const unixCount = source.split(from).length - 1;
  const windowsCount = windowsFrom === from ? 0 : source.split(windowsFrom).length - 1;
  if (unixCount + windowsCount !== 1) throw new Error(`${label}: expected one anchor, found ${unixCount + windowsCount}`);
  if (unixCount) source = source.replace(from, to);
  else source = source.replace(windowsFrom, windowsTo);
}

const promptRuleAnchor = [
  'Lower tool examples that suggest waiting do not override this rule.',
  '',
  'If you need to SELECT ALL existing text in a field and REPLACE it: use browser_fill',
].join('\n');
const explicitWaitSection = [
  'Lower tool examples that suggest waiting do not override this rule.',
  '',
  '### Explicit approved Wait steps only',
  '',
  'Only when the backend-selected current step itself is authored as Wait, Pause,',
  'Delay, Sleep, or stabilization may you call browser_wait_for with that step\'s',
  'declared condition. This is test behavior, not an ordinary validation technique.',
  '',
  'If you need to SELECT ALL existing text in a field and REPLACE it: use browser_fill',
].join('\n');
let anchor = promptRuleAnchor;
let replacement = explicitWaitSection;
if (!source.includes(anchor)) {
  anchor = promptRuleAnchor.replace(/\n/g, '\r\n');
  replacement = explicitWaitSection.replace(/\n/g, '\r\n');
}
if (!source.includes(anchor)) throw new Error('Missing zero-latency prompt anchor');
source = source.replace(anchor, replacement);

const lowerStart = source.indexOf('If you need to SELECT ALL existing text in a field and REPLACE it: use browser_fill');
const lowerEnd = source.indexOf('function pause(ms)', lowerStart);
if (lowerStart < 0 || lowerEnd < 0) throw new Error('Could not isolate lower SYSTEM_PROMPT_LOOP recipes');
const before = source.slice(0, lowerStart);
let lowerPrompt = source.slice(lowerStart, lowerEnd);
const after = source.slice(lowerEnd);
let neutralized = 0;
lowerPrompt = lowerPrompt.replace(/^([ \t]*).*browser_wait_for.*\r?$/gm, (_line, indent) => {
  neutralized += 1;
  return `${indent}-> Use cached post-action evidence; if inconclusive, take at most one browser_snapshot and validate immediately. Do not wait or poll.`;
});
if (neutralized < 10) throw new Error(`Expected many conflicting wait recipes, neutralized only ${neutralized}`);
source = before + lowerPrompt + after;
const staleWaitGuidance = '`  - The page is still loading - try browser_wait_for the element first.`';
const fastSnapshotGuidance = '`  - Use cached post-action state first; if it is inconclusive, take one fresh browser_snapshot and re-resolve immediately.`';
if (!source.includes(staleWaitGuidance)) throw new Error('Missing stale locator wait guidance');
source = source.replace(staleWaitGuidance, fastSnapshotGuidance);

replaceOnce(
  [
    '      if (widgetVerification.isSuggestionPickStep(step)) {',
    '        const snap = await freshSnapshotText();',
    '        if (widgetVerification.autocompleteHasNoResults(snap)) {',
    "          return { status: 'blocked', matched: false, checked: true, reason: 'autocomplete_no_results',",
    '            evidence: \'The autocomplete/suggestion panel shows "No Records Found" - there is no suggestion to click. This is a test-data/precondition issue: provide a valid value that returns suggestions. Do NOT improvise another value or navigate to a different module.\' };',
    '        }',
    '        // Suggestions exist but the panel is STILL OPEN -> no suggestion was actually',
    '        // chosen yet. Do not seal on "no verification" - require the pick to commit',
    '        // (panel closes / field reflects the choice).',
    '        if (widgetVerification.suggestionPanelOpen(snap, mcp.parseSnapshotLine || null)) {',
    "          return { status: 'blocked', matched: false, checked: true, reason: 'autocomplete_not_selected',",
    "            evidence: 'The suggestion panel is still open - no suggestion has been committed. Click an actual suggestion row so the field reflects the chosen value; the tool returning is not proof of selection.' };",
    '        }',
    '      }',
  ].join('\n'),
  [
    '      if (widgetVerification.isSuggestionPickStep(step)) {',
    '        const suggestionValidation = await validateSnapshotSinglePass({',
    '          probe: (snapshotText) => ({',
    '            usable: !!String(snapshotText || \'\').trim(),',
    '            noResults: widgetVerification.autocompleteHasNoResults(snapshotText),',
    '            panelOpen: widgetVerification.suggestionPanelOpen(snapshotText, mcp.parseSnapshotLine || null),',
    '          }),',
    '          isMatch: (value) => value?.usable === true,',
    '        });',
    '        if (!suggestionValidation.matched) {',
    "          return { status: 'blocked', matched: false, checked: false, reason: 'suggestion_snapshot_unavailable',",
    "            evidence: 'Autocomplete state could not be validated because cached evidence was blank and the one fresh snapshot was unavailable.' };",
    '        }',
    '        const suggestionState = suggestionValidation.value;',
    '        if (suggestionState.noResults) {',
    "          return { status: 'blocked', matched: false, checked: true, reason: 'autocomplete_no_results',",
    '            evidence: \'The autocomplete/suggestion panel shows "No Records Found" - there is no suggestion to click. This is a test-data/precondition issue: provide a valid value that returns suggestions. Do NOT improvise another value or navigate to a different module.\' };',
    '        }',
    '        if (suggestionState.panelOpen) {',
    "          return { status: 'blocked', matched: false, checked: true, reason: 'autocomplete_not_selected',",
    "            evidence: 'The suggestion panel is still open - no suggestion has been committed. Click an actual suggestion row so the field reflects the chosen value; the tool returning is not proof of selection.' };",
    '        }',
    '      }',
  ].join('\n'),
  'autocomplete cached-first validation',
);

replaceOnce(
  '        const decision = resultBearing.decideResultOutcome({ step, snapshotText: await freshSnapshotText() });',
  [
    '        const resultValidation = await validateSnapshotSinglePass({',
    '          probe: (snapshotText) => ({',
    '            usable: !!String(snapshotText || \'\').trim(),',
    '            decision: resultBearing.decideResultOutcome({ step, snapshotText }),',
    '          }),',
    '          isMatch: (value) => value?.usable === true,',
    '        });',
    '        if (!resultValidation.matched) {',
    "          return { status: 'blocked', matched: false, checked: false, reason: 'result_snapshot_unavailable',",
    "            evidence: 'Result state could not be validated because cached evidence was blank and the one fresh snapshot was unavailable.' };",
    '        }',
    '        const decision = resultValidation.value.decision;',
  ].join('\n'),
  'result-bearing cached-first validation',
);

replaceOnce(
  '  const freshSnapshotText = async (options = {}) => (await freshValidationSnapshot(options)).text;\n',
  '',
  'unused fresh snapshot wrapper',
);

fs.writeFileSync(outputPath, source, 'utf8');
process.stdout.write(`${outputPath}\nneutralized=${neutralized}\n`);
