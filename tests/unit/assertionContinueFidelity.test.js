import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference.js');

describe('authored assertion failure continuation', () => {
  it('soft-fails a non-critical mismatch instead of converting it to a comment', () => {
    const source = playwrightReference.emitAssertion({
      op: 'assert',
      channel: 'UI_TEXT',
      expected: 'Active = 63',
      liveOutcome: 'not_matched',
      criticality: 'should',
    });

    expect(source).toContain('expect.soft(false');
    expect(source).toContain('continues later independent steps');
    expect(source).not.toContain('qaai-degraded-pass');
  });

  it('keeps an uncheckable authored assertion executable and continuing', () => {
    const source = playwrightReference.emitAssertion({
      op: 'assert',
      channel: 'EVALUATE',
      liveOutcome: 'uncheckable',
    });

    expect(source).toContain('expect.soft(false');
    expect(source).toContain('could not reproduce this authored check');
  });

  it('soft-fails a missing evaluate script instead of emitting annotation-only output', () => {
    const source = playwrightReference.emitAssertion({
      op: 'assert',
      channel: 'EVALUATE',
      expected: 'true',
    });

    expect(source).toContain('expect.soft(false');
    expect(source).toContain('evaluation script was not captured');
  });
});
