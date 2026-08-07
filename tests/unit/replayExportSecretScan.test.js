const {
  scanSecrets,
  redactSecretLiteralsInFiles,
} = require('../../server/services/codegen/replayExport');

describe('Replay export secret scanning', () => {
  it('does not treat password metadata inside a data-bind value as a secret assignment', () => {
    const files = {
      'evidence/replayir.json': '{\n  "data-bind": "css: { password: \'field-metadata\' }"\n}\n',
    };

    expect(scanSecrets(files)).toEqual([]);
  });

  it('still rejects real JSON, variable, and property secret assignments', () => {
    const findings = scanSecrets({
      'evidence/unsafe.json': '{\n  "password": "synthetic-literal"\n}\n',
      'tests/unsafe.spec.js': [
        'const token = "synthetic-token";',
        'config.credential = "synthetic-credential";',
      ].join('\n'),
    });

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.rule === 'secret_literal_in_output')).toBe(true);
  });

  it('still rejects a known secret literal anywhere in the package', () => {
    const findings = scanSecrets(
      { 'README.md': 'fixture value: known-deny-literal' },
      ['known-deny-literal'],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('known_secret_literal');
  });

  it('redacts secret assignments and deny-list literals without hiding generated files', () => {
    const files = redactSecretLiteralsInFiles({
      'tests/login.spec.js': 'const password = "synthetic-password";\n',
      'evidence/runtime.json': '{\n  "token": "synthetic-token"\n}\n',
      'README.md': 'Known value: deny-me',
    }, ['deny-me']);

    expect(files['tests/login.spec.js']).toContain('process.env.QAAI_PASSWORD');
    expect(files['evidence/runtime.json']).toContain('"token": "__QAAI_REDACTED__"');
    expect(files['README.md']).toContain('__QAAI_REDACTED__');
    expect(scanSecrets(files, ['deny-me'])).toEqual([]);
  });
});
