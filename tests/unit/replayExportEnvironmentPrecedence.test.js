const replayExport = require('../../server/services/codegen/replayExport');

describe('generated Playwright environment precedence', () => {
  it('keeps non-empty CI/runtime values authoritative over bundled .env fallbacks', () => {
    const files = replayExport.assemblePackage({
      adapterId: 'playwright-pom-js',
      admitted: [],
      envVars: ['QAAI_USERNAME', 'QAAI_PASSWORD'],
      authState: null,
      targetUrl: 'https://app.example.test',
      envDefaults: {
        QAAI_USERNAME: 'authorized.user@example.test',
        QAAI_PASSWORD: 'Authorized-Password-42!',
      },
    });

    const config = files['playwright.config.ts'];
    expect(config).toContain('if (!value) continue;');
    expect(config).toContain(
      "if (process.env[key] != null && String(process.env[key]).trim() !== '') continue;",
    );
    expect(config).toContain('process.env[key] = value;');
    expect(config).not.toContain('Always override');
    expect(files['.env']).toContain('QAAI_USERNAME=authorized.user@example.test');
    expect(files['.env']).toContain('QAAI_PASSWORD=Authorized-Password-42!');
    expect(files['.env.example']).toContain('QAAI_USERNAME=\n');
    expect(files['.env.example']).toContain('QAAI_PASSWORD=\n');
    expect(files['.env.example']).not.toContain('authorized.user@example.test');
    expect(files['.env.example']).not.toContain('Authorized-Password-42!');
  });

  it('isolates distinct inline credentials and excludes negative credential payloads', () => {
    const positiveResult = (caseName, username, password) => ({
      caseName,
      declaredSteps: [
        {
          action: 'Fill',
          element: 'Username field',
          value: username,
          expected: 'Valid username entered',
        },
        {
          action: 'Fill',
          element: 'Password field',
          value: password,
          expected: 'Valid password entered',
        },
      ],
      envelope: {
        ir: {
          steps: [
            { op: 'act', action: 'fill', target: 'username', valueRef: 'env:QAAI_USERNAME' },
            { op: 'act', action: 'fill', target: 'password', valueRef: 'env:QAAI_PASSWORD' },
          ],
        },
      },
    });
    const first = positiveResult(
      'Primary sign in',
      'first.user@example.test',
      'First-Password-42!',
    );
    const second = positiveResult(
      'Secondary sign in',
      'second.user@example.test',
      'Second-Password-84!',
    );
    const negative = {
      caseName: 'Login with wrong password',
      declaredSteps: [
        {
          action: 'Fill',
          element: 'Password field',
          value: 'wrong-password',
          expected: 'Wrong password entered',
        },
      ],
      envelope: {
        ir: {
          steps: [{ op: 'act', action: 'fill', target: 'password', valueRef: 'env:QAAI_PASSWORD' }],
        },
      },
    };

    const bound = replayExport.bindCredentialEnvironment({ results: [first, second, negative] });

    expect(first.envelope.ir.steps.map((step) => step.valueRef)).toEqual([
      'env:QAAI_USERNAME',
      'env:QAAI_PASSWORD',
    ]);
    expect(second.envelope.ir.steps.map((step) => step.valueRef)).toEqual([
      'env:QAAI_USER2_USERNAME',
      'env:QAAI_USER2_PASSWORD',
    ]);
    expect(bound.defaults).toMatchObject({
      QAAI_USERNAME: 'first.user@example.test',
      QAAI_PASSWORD: 'First-Password-42!',
      QAAI_USER2_USERNAME: 'second.user@example.test',
      QAAI_USER2_PASSWORD: 'Second-Password-84!',
    });
    expect(Object.values(bound.defaults)).not.toContain('wrong-password');
  });

  it('ships an exact Playwright POM JavaScript dependency contract with a matching npm lockfile', () => {
    const files = replayExport.assemblePackage({
      adapterId: 'playwright-pom-js',
      admitted: [],
      envVars: ['QAAI_TARGET_URL'],
      targetUrl: 'https://app.example.test',
    });
    const packageJson = JSON.parse(files['package.json']);
    const packageLock = JSON.parse(files['package-lock.json']);
    const lockedRoot = packageLock.packages[''];

    expect(packageJson.type).toBe('module');
    expect(packageJson.devDependencies).toEqual({
      '@axe-core/playwright': '4.12.1',
      '@playwright/test': '1.61.1',
    });
    expect(packageLock.lockfileVersion).toBe(3);
    expect(lockedRoot.devDependencies).toEqual(packageJson.devDependencies);
    expect(packageLock.packages['node_modules/@playwright/test']).toMatchObject({
      version: '1.61.1',
    });
    expect(packageLock.packages['node_modules/@playwright/test'].integrity).toMatch(/^sha512-/);
    expect(packageLock.packages['node_modules/@axe-core/playwright']).toMatchObject({
      version: '4.12.1',
    });
    expect(packageLock.packages['node_modules/@axe-core/playwright'].integrity).toMatch(/^sha512-/);
    expect(files['README.md']).toContain('`npm ci`');
  });
});
