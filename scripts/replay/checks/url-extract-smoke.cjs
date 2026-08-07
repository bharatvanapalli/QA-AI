'use strict';

/**
 * Smoke test for the snapshot URL extractor introduced 2026-05-28 to fix
 * SauceDemo's post-redirect URL miss. Exits 0 if all cases pass, non-zero
 * otherwise. Lives under scripts/replay/checks/ per the replay-harness
 * charter; runs in milliseconds, no DB or AI calls.
 */

function extractUrlFromSnapshot(snap) {
  if (!snap || typeof snap !== 'string') return null;
  const headerMatch = snap.match(/Page URL:\s*(\S+)/i);
  if (headerMatch?.[1]) return headerMatch[1];
  const leadMatch = snap.match(/^(https?:\/\/[^\s]+)\s+-\s+Page Title:/);
  if (leadMatch?.[1]) return leadMatch[1];
  const candidates = snap.match(/https?:\/\/[^\s"'<>]+/g) || [];
  for (const u of candidates) {
    if (/^https?:\/\/(www\.)?w3\.org\//.test(u)) continue;
    if (/^https?:\/\/schemas\./.test(u)) continue;
    if (/^https?:\/\/purl\.org\//.test(u)) continue;
    if (/^https?:\/\/xmlns\./.test(u)) continue;
    return u;
  }
  return null;
}

const cases = [
  {
    name: 'login-success (lead-URL with Page Title)',
    snap: 'https://www.saucedemo.com/inventory.html - Page Title: Swag Labs ### Snapshot ```yaml...',
    expect: 'https://www.saucedemo.com/inventory.html',
  },
  {
    name: 'xss-skips-svg-namespace',
    snap: '- generic [ref=e10]: SVG xmlns="http://www.w3.org/2000/svg" then https://www.saucedemo.com/ in footer',
    expect: 'https://www.saucedemo.com/',
  },
  {
    name: 'post-logout (redirected to root)',
    snap: 'https://www.saucedemo.com/ - Page Title: Swag Labs ### Snapshot - heading...',
    expect: 'https://www.saucedemo.com/',
  },
  {
    name: 'page-url-header format',
    snap: 'Page URL: https://example.com/dashboard\n\nSnapshot...',
    expect: 'https://example.com/dashboard',
  },
  {
    name: 'empty input',
    snap: '',
    expect: null,
  },
  {
    name: 'only-svg-no-real-url',
    snap: 'http://www.w3.org/2000/svg and nothing else',
    expect: null,
  },
  {
    name: 'loose-match-with-non-page-noise',
    snap: 'random text https://app.com/page in middle',
    expect: 'https://app.com/page',
  },
];

let failures = 0;
for (const c of cases) {
  const got = extractUrlFromSnapshot(c.snap);
  const ok = got === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  got=${JSON.stringify(got)}  want=${JSON.stringify(c.expect)}`);
}
console.log();
console.log(failures === 0 ? `All ${cases.length} cases passed.` : `${failures}/${cases.length} cases FAILED.`);
process.exit(failures === 0 ? 0 : 1);
