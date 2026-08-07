import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  executeGenericClick,
  parseAuthoredOptionClickIntent,
} = require('../../server/services/genericClickExecution');

function queuedObserver(observations) {
  const queue = [...observations];
  return async () => queue.shift();
}

describe('genericClickExecution authored option clicks', () => {
  it('parses owner, ordinal, and exact option value without website-specific rules', () => {
    expect(parseAuthoredOptionClickIntent(
      'Click the second Organization option, Secondary Organization',
    )).toEqual({
      kind: 'authored_option_click',
      originalTarget: 'Click the second Organization option, Secondary Organization',
      ownerLabel: 'Organization',
      ordinal: 2,
      ordinalText: 'second',
      exactValue: 'Secondary Organization',
      exactValueQuoted: false,
    });
  });

  it.each([
    'Sign in with an identity provider option',
    'option that continues to the application',
    'second Organization option',
    'option, choose any available value',
    'second Region option, Central and verify the selected label',
  ])('leaves ambiguous or ordinary option prose on the normal click path: %s', (target) => {
    expect(parseAuthoredOptionClickIntent(target)).toBeNull();
  });

  it('resolves and dispatches the exact option row instead of its owner combobox', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const target = 'second Organization option, Secondary Organization';
    const result = await executeGenericClick({
      step: {
        id: 'choose-organization',
        action: 'Click',
        target,
        operationCheck: {
          kind: 'page_ready',
          expectedState: { urlPattern: '/selected' },
        },
      },
      target,
      observe: queuedObserver([
        {
          snapshotText: [
            '- combobox "Organization" [expanded] [ref=owner-ref]',
            '- listbox "Organization options"',
            '  - option "Primary Organization" [ref=first-option-ref]',
            '  - option "Secondary Organization" [ref=second-option-ref]',
          ].join('\n'),
          url: 'https://app.example.test/create',
          title: 'Create',
          fresh: true,
        },
        {
          snapshotText: '- main "Selected organization"',
          url: 'https://app.example.test/selected',
          title: 'Selected',
          fresh: true,
        },
      ]),
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ handled: true, terminal: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].resolution).toMatchObject({
      ref: 'second-option-ref',
      control: {
        role: 'option',
        name: 'Secondary Organization',
      },
      authoredOptionIntent: {
        ownerLabel: 'Organization',
        ordinal: 2,
        exactValue: 'Secondary Organization',
      },
      resolutionTarget: {
        authoredLabel: 'Secondary Organization',
        role: 'option',
      },
    });
  });

  it('passes the exact option contract to authoritative fallback when snapshots lack the row', async () => {
    const resolveAuthoritative = vi.fn(async () => null);
    const dispatch = vi.fn();
    const target = 'third Equipment option: LTL';
    await executeGenericClick({
      step: { action: 'Click', target },
      target,
      observe: queuedObserver([{
        snapshotText: '- combobox "Equipment" [ref=equipment-owner]',
        url: 'https://app.example.test/create',
        title: 'Create',
        fresh: true,
      }]),
      resolveAuthoritative,
      dispatch,
      seal: async () => ({}),
    });

    expect(resolveAuthoritative).toHaveBeenCalledWith(expect.objectContaining({
      target: 'LTL',
      originalTarget: target,
      authoredOptionIntent: expect.objectContaining({
        ownerLabel: 'Equipment',
        ordinal: 3,
        exactValue: 'LTL',
      }),
      resolutionTarget: {
        authoredLabel: 'LTL',
        contextTokens: ['Equipment'],
        role: 'option',
      },
    }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('waits internally for an asynchronously rendered exact option before clicking it', async () => {
    const sleep = vi.fn(async () => {});
    const prepareAuthoredOption = vi.fn(async () => true);
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const target = 'second Organization option, Secondary Organization';
    const result = await executeGenericClick({
      step: {
        action: 'Click',
        target,
        operationCheck: { kind: 'page_ready', expectedState: { urlPattern: '/selected' } },
      },
      target,
      observe: queuedObserver([
        {
          snapshotText: '- combobox "Organization" [expanded] [ref=owner-ref]: SEARCH',
          url: 'https://app.example.test/create',
          title: 'Create',
          fresh: true,
        },
        {
          snapshotText: [
            '- combobox "Organization" [expanded] [ref=owner-ref]: SEARCH',
            '- listbox "Organization options"',
            '  - option "Secondary Organization" [ref=second-option-ref]',
          ].join('\n'),
          url: 'https://app.example.test/create',
          title: 'Create',
          fresh: true,
        },
        {
          snapshotText: '- main "Selected organization"',
          url: 'https://app.example.test/selected',
          title: 'Selected',
          fresh: true,
        },
      ]),
      dispatch,
      prepareAuthoredOption,
      sleep,
      seal: async () => ({}),
    });

    expect(prepareAuthoredOption).toHaveBeenCalledWith(expect.objectContaining({
      authoredOptionIntent: expect.objectContaining({ exactValue: 'Secondary Organization' }),
    }));
    expect(sleep).toHaveBeenCalledWith(300);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].resolution).toMatchObject({
      ref: 'second-option-ref',
      authoredOptionIntent: { exactValue: 'Secondary Organization' },
    });
    expect(result).toMatchObject({ handled: true, terminal: false });
  });

  it('refreshes an unresolved autocomplete query with bounded backoff before giving up', async () => {
    const sleep = vi.fn(async () => {});
    const prepareAuthoredOption = vi.fn(async () => true);
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const unresolved = {
      snapshotText: '- combobox "Organization" [ref=owner-ref]: SEARCH',
      url: 'https://app.example.test/create',
      title: 'Create',
      fresh: true,
    };
    const optionVisible = {
      snapshotText: [
        '- combobox "Organization" [expanded] [ref=owner-ref]: SEARCH',
        '- listbox "Organization options"',
        '  - option "Secondary Organization" [ref=second-option-ref]',
      ].join('\n'),
      url: 'https://app.example.test/create',
      title: 'Create',
      fresh: true,
    };
    const selected = {
      snapshotText: '- main "Selected organization"',
      url: 'https://app.example.test/selected',
      title: 'Selected',
      fresh: true,
    };
    const result = await executeGenericClick({
      step: {
        action: 'Click',
        target: 'second Organization option, Secondary Organization',
        operationCheck: { kind: 'page_ready', expectedState: { urlPattern: '/selected' } },
      },
      target: 'second Organization option, Secondary Organization',
      observe: queuedObserver([
        unresolved,
        ...Array.from({ length: 8 }, () => ({ ...unresolved })),
        optionVisible,
        selected,
      ]),
      dispatch,
      prepareAuthoredOption,
      sleep,
      seal: async () => ({}),
    });

    expect(prepareAuthoredOption).toHaveBeenCalledTimes(2);
    expect(prepareAuthoredOption.mock.calls[0][0]).toMatchObject({ attempt: 1 });
    expect(prepareAuthoredOption.mock.calls[1][0]).toMatchObject({ attempt: 2 });
    expect(sleep).toHaveBeenCalledWith(500);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ handled: true, terminal: false });
  });
});

describe('genericClickExecution transition reconciliation', () => {
  it('waits for a delayed landing oracle without repeating the click', async () => {
    const home = {
      snapshotText: '- heading "Home" [level=1]\n- link "Orders" [ref=orders]',
      url: 'https://app.example.test/home',
      title: 'Home',
      fresh: true,
    };
    const orders = {
      snapshotText: '- heading "Orders" [level=1]\n- button "Create Order" [ref=create-order]',
      url: 'https://app.example.test/orders',
      title: 'Orders',
      fresh: true,
    };
    const observe = vi.fn(queuedObserver([home, home, home, home, orders]));
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const sleep = vi.fn(async () => {});

    const result = await executeGenericClick({
      step: { action: 'Click', target: 'Orders' },
      target: 'Orders',
      transitionSteps: [
        { action: 'Click', target: 'Orders' },
        {
          action: 'AssertVisible',
          verify: { kind: 'visible', element: { role: 'heading', name: 'Orders page' } },
        },
      ],
      observe,
      dispatch,
      sleep,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ handled: true, terminal: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics.final).toMatchObject({
      status: 'pass',
      retried: false,
    });
  });

  it('never redispatches a delivered click when postcondition evidence stays unavailable', async () => {
    const secret = 'generic-click-snapshot-secret-42';
    const page = {
      snapshotText: `- textbox "Password": ${secret}\n- button "Submit" [ref=submit]`,
      url: 'https://app.example.test/form',
      title: 'Form',
      fresh: true,
    };
    const observe = vi.fn(async () => ({ ...page }));
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));

    const result = await executeGenericClick({
      step: {
        id: 'submit-once',
        action: 'Click',
        target: 'Submit',
        operationCheck: { kind: 'page_ready', expectedState: { urlPattern: '/complete' } },
      },
      target: 'Submit',
      observe,
      dispatch,
      sleep: async () => {},
      seal: async () => ({}),
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ handled: true, terminal: true });
    expect(result.diagnostics.final).toMatchObject({ retried: false });
    expect(result.diagnostics.transaction.dispatchAttemptCount).toBe(1);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
    expect(JSON.stringify(result.diagnostics.transaction)).toContain('snapshotRef');
  });
});
