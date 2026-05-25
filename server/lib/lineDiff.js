'use strict';

/**
 * Minimal line-level diff for the Governance side-by-side viewer (Phase 8).
 *
 * Computes an LCS (longest common subsequence) over the two line arrays, then
 * walks both to produce a stream of side-by-side rows. Each row is one of:
 *   - { kind: 'equal',   leftNo, leftText, rightNo, rightText }
 *   - { kind: 'remove',  leftNo, leftText, rightNo: null, rightText: null }
 *   - { kind: 'add',     leftNo: null, leftText: null, rightNo, rightText }
 *
 * No 'changed' row — paired removes/adds render side-by-side in the UI by
 * walking the row list and aligning consecutive remove + add pairs visually.
 *
 * Sufficient for our scale: spec files are <2k lines; LCS is O(M*N) which
 * is fine. For files >5k lines we'd want Myers, but we're nowhere near.
 */

function splitLines(text) {
  if (text == null) return [];
  // Keep blank lines; tolerate Windows line endings.
  return String(text).replace(/\r\n/g, '\n').split('\n');
}

/** Build the LCS table (length grid). */
function lcsTable(a, b) {
  const m = a.length;
  const n = b.length;
  // Single flat array sized (m+1)*(n+1); faster than nested arrays.
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const idx = i * (n + 1) + j;
      if (a[i] === b[j]) {
        dp[idx] = dp[(i + 1) * (n + 1) + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * (n + 1) + j];
        const right = dp[i * (n + 1) + (j + 1)];
        dp[idx] = down > right ? down : right;
      }
    }
  }
  return { dp, m, n };
}

/**
 * Produce the side-by-side row stream by walking the LCS table.
 * Lines are 1-indexed for display.
 */
function diffLines(left, right) {
  const a = splitLines(left);
  const b = splitLines(right);
  const { dp, n } = lcsTable(a, b);
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'equal', leftNo: i + 1, leftText: a[i], rightNo: j + 1, rightText: b[j] });
      i++; j++;
    } else {
      const down = dp[(i + 1) * (n + 1) + j];
      const right = dp[i * (n + 1) + (j + 1)];
      if (down >= right) {
        rows.push({ kind: 'remove', leftNo: i + 1, leftText: a[i], rightNo: null, rightText: null });
        i++;
      } else {
        rows.push({ kind: 'add', leftNo: null, leftText: null, rightNo: j + 1, rightText: b[j] });
        j++;
      }
    }
  }
  while (i < a.length) {
    rows.push({ kind: 'remove', leftNo: i + 1, leftText: a[i], rightNo: null, rightText: null });
    i++;
  }
  while (j < b.length) {
    rows.push({ kind: 'add', leftNo: null, leftText: null, rightNo: j + 1, rightText: b[j] });
    j++;
  }
  return rows;
}

/**
 * Summary counts for the diff header chip.
 */
function summarise(rows) {
  let added = 0;
  let removed = 0;
  let equal = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'remove') removed++;
    else equal++;
  }
  return { added, removed, equal, total: rows.length };
}

module.exports = { diffLines, summarise, splitLines };
