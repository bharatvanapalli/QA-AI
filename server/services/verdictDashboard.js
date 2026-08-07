'use strict';

/**
 * Phase H M5 — disagreement-rate aggregation helper.
 *
 * Pure function over a list of `{verdictVersion, status, flipDirection}`
 * RunResult rows. No DB, no LLM, no side effects. Lives outside the
 * dashboard route so it can be smoke-tested in isolation, and so the
 * bucketing rules sit in one obvious place — they are the spec for the
 * verdict-integrity headline ("rescued false-fails", etc.).
 *
 * Returns:
 *   {
 *     verdictVersions: [{
 *       verdictVersion, totalRuns, agreedCount, disagreedCount,
 *       disagreementRate, rescuedFalseFails, surfacedUncheckables,
 *       caughtOverclaimedPasses, suspiciousPasses, otherFlips
 *     }],
 *     headline: string
 *   }
 *
 * `headline` is the one-sentence summary the UI renders verbatim. Empty
 * string when there's nothing meaningful to say (no mechanical_v1 rows),
 * so the card hides itself client-side.
 */
function aggregateVerdictDisagreement(rows, { windowDays = 7 } = {}) {
  const buckets = new Map();
  function bucket(v) {
    let b = buckets.get(v);
    if (!b) {
      b = {
        verdictVersion: v,
        totalRuns: 0,
        agreedCount: 0,
        disagreedCount: 0,
        rescuedFalseFails: 0,
        surfacedUncheckables: 0,
        caughtOverclaimedPasses: 0,
        suspiciousPasses: 0,
        otherFlips: 0,
      };
      buckets.set(v, b);
    }
    return b;
  }

  for (const r of rows || []) {
    const b = bucket((r && r.verdictVersion) || 'legacy');
    b.totalRuns += 1;
    if (r && r.flipDirection) {
      b.disagreedCount += 1;
      switch (r.flipDirection) {
        case 'FAIL_TO_PASS':  b.rescuedFalseFails       += 1; break;
        case 'PASS_TO_FAIL':  b.caughtOverclaimedPasses += 1; break;
        default:              b.otherFlips              += 1; break;
      }
    } else {
      b.agreedCount += 1;
    }
  }

  const verdictVersions = Array.from(buckets.values()).map((b) => ({
    ...b,
    disagreementRate: b.totalRuns > 0
      ? Math.round((b.disagreedCount / b.totalRuns) * 1000) / 10
      : 0,
  }));

  // Stable order: legacy first, mechanical_v1 second, then anything else.
  const order = { legacy: 0, mechanical_v1: 1 };
  verdictVersions.sort((a, b) => (order[a.verdictVersion] ?? 9) - (order[b.verdictVersion] ?? 9));

  const mech = verdictVersions.find((v) => v.verdictVersion === 'mechanical_v1');
  let headline = '';
  if (mech && mech.totalRuns > 0) {
    const wins = [];
    const losses = [];
    if (mech.rescuedFalseFails > 0)       wins.push(`${mech.rescuedFalseFails} false-fail${mech.rescuedFalseFails === 1 ? '' : 's'} rescued`);
    if (mech.caughtOverclaimedPasses > 0) losses.push(`${mech.caughtOverclaimedPasses} over-claimed pass${mech.caughtOverclaimedPasses === 1 ? '' : 'es'} caught`);
    const parts = [...wins, ...losses];
    if (parts.length) {
      headline = `mechanical_v1: ${parts.join(' · ')} in the last ${windowDays} day${windowDays === 1 ? '' : 's'}.`;
    } else {
      headline = `mechanical_v1: ${mech.totalRuns} run${mech.totalRuns === 1 ? '' : 's'}, 0 disagreements in the last ${windowDays} day${windowDays === 1 ? '' : 's'}.`;
    }
  }

  return { verdictVersions, headline };
}

module.exports = { aggregateVerdictDisagreement };
