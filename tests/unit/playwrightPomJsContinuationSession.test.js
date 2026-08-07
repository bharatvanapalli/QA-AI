const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');

function flowCase({
  id,
  title,
  sessionMode = 'fresh',
  dependsOnIds = [],
  failurePolicy = 'continue_independent',
  steps = [],
}) {
  return {
    testCaseId: id,
    caseId: id,
    caseName: title,
    sessionMode,
    dependsOnIds,
    failurePolicy,
    ir: {
      caseId: id,
      title,
      steps,
    },
  };
}

function navigateStep(id, url) {
  return {
    op: 'act',
    action: 'navigate',
    url,
    value: url,
    authored: true,
    contractStepId: id,
  };
}

function pageAssertion(id, expected) {
  return {
    op: 'assert',
    channel: 'PAGE',
    expected,
    authored: true,
    contractStepId: id,
  };
}

describe('Playwright POM JavaScript continuation sessions', () => {
  test('runs a dependency and continuation in one test on the same fixture page without replaying setup', () => {
    const login = flowCase({
      id: 'auth-login',
      title: 'Establish authenticated session',
      failurePolicy: 'block_dependents',
      steps: [navigateStep('open-login', 'https://app.example.test/login')],
    });
    const administration = flowCase({
      id: 'admin-continuation',
      title: 'Continue to account administration',
      sessionMode: 'continue_from_dependency',
      dependsOnIds: ['auth-login'],
      failurePolicy: 'block_dependents',
      steps: [pageAssertion('confirm-authenticated-state', '/administration')],
    });

    // Deliberately reversed input proves dependency ordering comes from metadata,
    // not from a website-specific input position assumption.
    const output = playwrightPom.emitJourneySpec([administration, login], {
      lang: 'js',
      moduleFormat: 'esm',
      scenarioName: 'Authenticated administration',
    });

    expect(output.content.match(/async \(\{ page \}\) => \{/g) || []).toHaveLength(1);
    expect(output.content.match(/await test\.step\(/g) || []).toHaveLength(2);
    expect(output.content.indexOf('test.step("Establish authenticated session"')).toBeLessThan(
      output.content.indexOf('test.step("Continue to account administration"'),
    );
    expect(output.content.match(/page\.goto\("https:\/\/app\.example\.test\/login", \{ waitUntil: 'domcontentloaded' \}\)/g) || []).toHaveLength(1);
    expect(output.content).toContain(
      'Session contract - sessionMode: continue_from_dependency; dependsOn: auth-login; failurePolicy: block_dependents.',
    );
    expect(output.content).not.toMatch(/\b(?:browser|context)\.newPage\s*\(/);
    expect(output.content).not.toMatch(/\bpage\.context\(\)\.newPage\s*\(/);
    expect(output.content).not.toContain(
      'test("Continue to account administration", async ({ page })',
    );
  });

  test('keeps opaque dependency identities out of generated session comments', () => {
    const dependencyId = '4af44607-e59b-4cd4-85a2-68dc1e89cdc9';
    const login = flowCase({
      id: dependencyId,
      title: 'Login through Microsoft',
      steps: [navigateStep('open-login', 'https://app.example.test/login')],
    });
    const continuation = flowCase({
      id: 'create-order',
      title: 'Create an order',
      sessionMode: 'continue_from_dependency',
      dependsOnIds: [dependencyId],
      steps: [pageAssertion('confirm-dashboard', '/dashboard')],
    });
    continuation.dependsOnNames = ['Login through Microsoft'];

    const output = playwrightPom.emitJourneySpec([continuation, login], {
      lang: 'js',
      moduleFormat: 'esm',
      scenarioName: 'Authenticated order flow',
    });

    expect(output.content).toContain('dependsOn: Login through Microsoft');
    expect(output.content).not.toContain(dependencyId);
    expect(output.content.indexOf('test.step("Login through Microsoft"')).toBeLessThan(
      output.content.indexOf('test.step("Create an order"'),
    );
  });

  test('keeps a standalone fresh case on the normal Playwright page fixture path', () => {
    const standalone = flowCase({
      id: 'public-home',
      title: 'Open public home',
      steps: [navigateStep('open-home', 'https://app.example.test/home')],
    });

    const output = playwrightPom.emitJourneySpec([standalone], {
      lang: 'js',
      moduleFormat: 'esm',
      scenarioName: 'Public home',
    });

    expect(output.content).toContain('test("Open public home", async ({ page }) => {');
    expect(output.content.match(/async \(\{ page \}\) => \{/g) || []).toHaveLength(1);
    expect(output.content).not.toContain('test.step(');
    expect(output.content).toContain('page.goto("https://app.example.test/home", { waitUntil: \'domcontentloaded\' })');
  });

  test('does not pull an unrelated standalone case into a continuation session', () => {
    const login = flowCase({
      id: 'login',
      title: 'Log in',
      steps: [navigateStep('open-login', 'https://app.example.test/login')],
    });
    const continuation = flowCase({
      id: 'profile',
      title: 'Open profile in authenticated state',
      sessionMode: 'continue_from_dependency',
      dependsOnIds: ['login'],
      failurePolicy: 'block_dependents',
      steps: [pageAssertion('profile-visible', '/profile')],
    });
    const standalone = flowCase({
      id: 'status',
      title: 'Open public status',
      steps: [navigateStep('open-status', 'https://status.example.test/')],
    });

    const output = playwrightPom.emitJourneySpec([login, standalone, continuation], {
      lang: 'js',
      moduleFormat: 'esm',
      scenarioName: 'Mixed execution',
    });

    expect(output.content.match(/async \(\{ page \}\) => \{/g) || []).toHaveLength(2);
    expect(output.content.match(/await test\.step\(/g) || []).toHaveLength(2);
    expect(output.content).toContain('test("Open public status", async ({ page }) => {');
    expect(output.content.match(/page\.goto\("https:\/\/status\.example\.test\/", \{ waitUntil: 'domcontentloaded' \}\)/g) || []).toHaveLength(1);
  });
});
