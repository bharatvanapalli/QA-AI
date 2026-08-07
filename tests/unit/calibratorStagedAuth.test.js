import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const calibrator = require('../../server/services/agents/calibrator');
const mcp = require('../../server/services/mcp');

describe('calibrator staged auth discovery', () => {
  it('recognizes an email-classifier login page as driveable staged auth', () => {
    const snap = `
      - textbox "Email Address" [ref=e16] [placeholder="Enter your email"]
      - button "Continue" [ref=e18]
      - text "Internal users will use Microsoft authentication."
    `;

    const controls = calibrator.locateLoginControls(snap);

    expect(controls.userField?.ref).toBe('e16');
    expect(controls.pwField).toBeNull();
    expect(controls.submit?.ref).toBe('e18');
    expect(controls.isLoginLike).toBe(true);
    expect(calibrator.looksLikeFederatedLogin(controls.enriched)).toBe(true);
  });

  it('recognizes a provider button as a staged auth hop', () => {
    const snap = `
      - heading "Sign in"
      - button "Sign in with Microsoft" [ref=e22]
    `;

    const controls = calibrator.locateLoginControls(snap);

    expect(controls.providerButton?.ref).toBe('e22');
    expect(controls.userField).toBeNull();
    expect(controls.pwField).toBeNull();
    expect(controls.isLoginLike).toBe(true);
  });

  it('prioritizes Microsoft provider hop when the identifier field is disabled after email entry', () => {
    const snap = `
      - heading "Internal User Login"
      - textbox "Email Address" [disabled] [ref=e33]
      - button "Sign in with Microsoft" [ref=e35]
      - button "Back to Email" [ref=e36]
    `;

    const controls = calibrator.locateLoginControls(snap);

    expect(controls.userField?.ref).toBe('e33');
    expect(controls.userField?.disabled).toBe(true);
    expect(controls.providerButton?.ref).toBe('e35');
    expect(calibrator.shouldClickProviderBeforeIdentifier(
      controls,
      'OdysseyOneAutomationTester1@odysseylogistics.com',
      true,
    )).toBe(true);
    const observation = calibrator.classifyAuthScreenObservation(controls, {
      userValue: 'OdysseyOneAutomationTester1@odysseylogistics.com',
      submittedIdentifier: true,
      identifierState: { found: true, disabled: true, hasExpected: true, empty: false },
    });
    expect(observation.state).toBe('provider_handoff');
    expect(observation.action).toBe('click_provider');
  });

  it('keeps positional password fallback for ordinary forms', () => {
    const snap = `
      - textbox "Username" [ref=e1]
      - textbox [ref=e2]
      - button "Login" [ref=e3]
    `;

    const controls = calibrator.locateLoginControls(snap);

    expect(controls.userField?.ref).toBe('e1');
    expect(controls.pwField?.ref).toBe('e2');
    expect(controls.submit?.ref).toBe('e3');
  });

  it('does not classify a one-searchbox dashboard as federated login', () => {
    const snap = `
      - heading "Home"
      - textbox "Search" [ref=e10]
      - button "Filter" [ref=e11]
      - text "Welcome OdysseyOne!"
    `;

    const controls = calibrator.locateLoginControls(snap);

    expect(controls.isLoginLike).toBe(false);
    expect(calibrator.looksLikeFederatedLogin(controls.enriched)).toBe(false);
  });

  it('keeps MFA/OTP/CAPTCHA as a hard auth challenge', () => {
    const snap = `
      - heading "Verify your identity"
      - text "Enter code from your authenticator app"
      - textbox "Code" [ref=e31]
      - button "Verify" [ref=e32]
    `;

    expect(calibrator.isHardAuthChallengeSnapshot(snap)).toBe(true);
  });

  it('recognizes an IdP email retry screen after a validation error', () => {
    const snap = `
      - heading "Sign in"
      - text "Enter a valid email address, phone number, or Skype name."
      - textbox "Email, phone, or Skype" [ref=e16]
      - button "Next" [ref=e18]
      - button "Sign-in options" [ref=e19]
    `;

    const controls = calibrator.locateLoginControls(snap);

    expect(controls.userField?.ref).toBe('e16');
    expect(controls.submit?.ref).toBe('e18');
    expect(controls.isLoginLike).toBe(true);
    expect(calibrator.authFieldAppearsFilled(
      controls.userField,
      'OdysseyOneAutomationTester1@odysseylogistics.com',
    )).toBe(false);
    const observation = calibrator.classifyAuthScreenObservation(controls, {
      userValue: 'OdysseyOneAutomationTester1@odysseylogistics.com',
      submittedIdentifier: true,
      identifierState: { found: true, hasExpected: false, empty: true, value: '' },
    });
    expect(observation.state).toBe('identifier_required');
    expect(observation.action).toBe('enter_identifier');
    expect(observation.reason).toBe('screen_reports_missing_or_invalid_identifier');
  });

  it('does not invent a password field on a Microsoft identifier screen with an extra unnamed textbox', () => {
    const snap = `
      - heading "Sign in"
      - textbox "Enter your email, phone, or Skype." [ref=e29]
      - textbox "" [ref=e30]
      - button "Next" [ref=e36]
    `;

    const controls = calibrator.locateLoginControls(snap);

    expect(controls.userField?.ref).toBe('e29');
    expect(controls.pwField).toBeNull();
    expect(controls.submit?.ref).toBe('e36');

    const observation = calibrator.classifyAuthScreenObservation(controls, {
      userValue: 'OdysseyOneAutomationTester1@odysseylogistics.com',
      submittedIdentifier: true,
      identifierState: { found: true, hasExpected: false, empty: true, value: '' },
    });
    expect(observation.state).toBe('identifier_required');
    expect(observation.action).toBe('enter_identifier');
  });

  it('remembers crawl actions so duplicate probe clicks are skipped', () => {
    const messages = [];
    const ledger = calibrator.createCrawlActionLedger((level, message) => messages.push({ level, message }));

    expect(ledger.markOnce(['tab', '/home', 'Users', 'e1'], 'tab "Users"')).toBe(true);
    expect(ledger.markOnce(['tab', '/home', 'Users', 'e1'], 'tab "Users"')).toBe(false);
    expect(messages[0].message).toContain('action-ledger skip duplicate');
  });

  it('does not treat repeated MCP refs on different auth screens as the same action', () => {
    const appEmailSnap = `
      - heading "Welcome"
      - textbox "Email Address" [ref=e16]
      - button "Continue" [ref=e18]
      - text "Internal users will use Microsoft authentication."
    `;
    const idpEmailSnap = `
      - heading "Sign in"
      - textbox "Email, phone, or Skype" [ref=e16]
      - button "Next" [ref=e18]
    `;

    const appControls = calibrator.locateLoginControls(appEmailSnap);
    const idpControls = calibrator.locateLoginControls(idpEmailSnap);
    const appAction = calibrator.authActionKey('identifier', appControls, [appControls.userField.ref, appControls.submit.ref]);
    const idpAction = calibrator.authActionKey('identifier', idpControls, [idpControls.userField.ref, idpControls.submit.ref]);

    expect(appAction).not.toBe(idpAction);
  });

  it('only treats read-only view/detail controls as safe modal openers', () => {
    expect(calibrator.isSafeModalOpenerRow({
      role: 'button',
      name: 'View Details',
      ref: 'e20',
      flags: {},
    })).toBe(true);
    expect(calibrator.isSafeModalOpenerRow({
      role: 'button',
      name: 'More actions',
      ref: 'e21',
      flags: { haspopup: true },
    })).toBe(true);
    expect(calibrator.isSafeModalOpenerRow({
      role: 'button',
      name: 'Edit User',
      ref: 'e22',
      flags: {},
    })).toBe(false);
    expect(calibrator.isSafeModalOpenerRow({
      role: 'button',
      name: 'Add User',
      ref: 'e23',
      flags: {},
    })).toBe(false);
    expect(calibrator.isSafeModalOpenerRow({
      role: 'link',
      name: 'Sign out',
      ref: 'e24',
      flags: {},
    })).toBe(false);
  });

  it('routes crawler navigation through the authorized MCP boundary', async () => {
    const session = { id: 'crawl-session' };
    const toolResult = { content: [{ type: 'text', text: 'navigated' }] };
    const callTool = vi.spyOn(mcp, 'callTool').mockResolvedValueOnce(toolResult);

    await expect(calibrator.callCalibratorTool(session, {
      name: 'browser_navigate',
      arguments: { url: 'https://letcode.in/test' },
    })).resolves.toBe(toolResult);

    expect(callTool).toHaveBeenCalledWith(
      session,
      'browser_navigate',
      { url: 'https://letcode.in/test' },
      expect.objectContaining({ source: 'calibrator_crawl' }),
    );
    callTool.mockRestore();
  });

  it('turns an MCP tool error into an actionable crawl failure', async () => {
    const callTool = vi.spyOn(mcp, 'callTool').mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'navigation was blocked' }],
    });

    await expect(calibrator.callCalibratorTool(
      { id: 'crawl-session' },
      { name: 'browser_navigate', arguments: { url: 'https://letcode.in/test' } },
    )).rejects.toMatchObject({
      code: 'CALIBRATOR_MCP_TOOL_ERROR',
      toolName: 'browser_navigate',
      message: expect.stringContaining('navigation was blocked'),
    });
    callTool.mockRestore();
  });

  it('reports a zero-page crawl as a failure with the first page cause', () => {
    const err = calibrator.buildZeroPageCrawlError('https://letcode.in/test', [{
      url: 'https://letcode.in/test',
      code: 'ACTION_EXECUTION_GATEWAY_BYPASS',
      message: 'Direct mutating MCP SDK calls are forbidden.',
    }]);

    expect(err.code).toBe('CALIBRATION_ZERO_PAGES');
    expect(err.message).toContain('mapped 0 pages');
    expect(err.message).toContain('Direct mutating MCP SDK calls are forbidden.');
  });

  it('limits entry-page discovery to main content instead of global site navigation', async () => {
    const callTool = vi.spyOn(mcp, 'callTool').mockResolvedValueOnce({
      content: [{ type: 'text', text: '### Result\n[]' }],
    });

    await calibrator.extractLinksViaDom(
      { id: 'crawl-session' },
      'https://letcode.in',
      null,
      { contentOnly: true },
    );

    const evaluateSource = callTool.mock.calls[0][2].function;
    expect(evaluateSource).toContain('main');
    expect(evaluateSource).toContain('header, nav, aside, footer');
    expect(evaluateSource).toContain('[role=\\"navigation\\"]');
    callTool.mockRestore();
  });
});
