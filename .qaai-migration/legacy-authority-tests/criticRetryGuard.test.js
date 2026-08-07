import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve('server/routes/agents.js'), 'utf8');
const helperSource = source.match(
  /function shouldRunPostMortemCritic\([\s\S]*?\n\}/,
)?.[0];

if (!helperSource) throw new Error('shouldRunPostMortemCritic helper was not found');

// Evaluate only the pure policy helper. Requiring the entire Express route would
// start its long-lived runtime dependencies and make this unit test misleading.
const shouldRunPostMortemCritic = vm.runInNewContext(`(${helperSource})`);

describe('post-mortem Critic retry guard', () => {
  it('skips Critic after fast mode has used its only attempt', () => {
    expect(shouldRunPostMortemCritic({ attempt: 1, effectiveMaxAttempts: 1 })).toBe(false);
  });

  it('runs Critic only while another Conductor attempt remains', () => {
    expect(shouldRunPostMortemCritic({ attempt: 1, effectiveMaxAttempts: 2 })).toBe(true);
    expect(shouldRunPostMortemCritic({ attempt: 2, effectiveMaxAttempts: 2 })).toBe(false);
  });

  it('rejects invalid attempt bounds', () => {
    expect(shouldRunPostMortemCritic({ attempt: 0, effectiveMaxAttempts: 2 })).toBe(false);
    expect(shouldRunPostMortemCritic({ attempt: 1, effectiveMaxAttempts: 0 })).toBe(false);
    expect(shouldRunPostMortemCritic({})).toBe(false);
  });
});
