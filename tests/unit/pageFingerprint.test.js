import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fingerprint = require('../../server/services/pageFingerprint');

describe('page fingerprint', () => {
  it('captures structural page identity without field values', () => {
    const result = fingerprint.buildPageFingerprint({
      url: 'https://example.test/login?return=/home',
      title: 'Sign in',
      primaryHeading: 'Welcome',
      fields: [{ name: 'Email', type: 'email', value: 'private@example.test' }, { name: 'Password', type: 'password', value: 'secret' }],
      controls: [{ name: 'Continue', role: 'button' }],
    });
    expect(result.url).toBe('https://example.test/login');
    expect(JSON.stringify(result)).not.toContain('private@example.test');
    expect(JSON.stringify(result)).not.toContain('"secret"');
    expect(result.authState.loginControlVisible).toBe(false);
    expect(result.authState.passwordPromptVisible).toBe(true);
  });

  it('parses headings, fields, controls, dialogs, and messages from an accessibility snapshot', () => {
    const result = fingerprint.fromSnapshotText({
      url: 'https://example.test/users',
      snapshotText: '- heading "Users"\n- textbox "Search"\n- button "Add user"\n- dialog "Confirm"\n- alert "Validation failed"',
    });
    expect(result.primaryHeading).toBe('Users');
    expect(result.fields[0]).toMatchObject({ role: 'textbox', name: 'Search' });
    expect(result.controls[0]).toMatchObject({ role: 'button', name: 'Add user' });
    expect(result.activeDialog).toMatchObject({ role: 'dialog', name: 'Confirm' });
    expect(result.messages).toContain('Validation failed');
  });

  it('requires structural equivalence and reports changed channels', () => {
    const first = fingerprint.buildPageFingerprint({ url: 'https://example.test/a?x=1', title: 'A', fields: [{ name: 'Email', role: 'textbox' }] });
    const same = fingerprint.buildPageFingerprint({ url: 'https://example.test/a?x=2', title: 'A', fields: [{ name: 'Email', role: 'textbox' }] });
    const changed = fingerprint.buildPageFingerprint({ url: 'https://example.test/b', title: 'B', fields: [] });
    expect(fingerprint.equivalent(first, same)).toBe(true);
    expect(fingerprint.diff(first, changed).channels).toEqual(expect.arrayContaining(['url', 'title', 'fields']));
  });
});
