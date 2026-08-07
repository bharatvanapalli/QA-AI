import { describe, expect, it } from 'vitest';
import adaptersModule from '../../server/services/mcpBrowserEventAdapters';
import brokerModule from '../../server/services/browserEventBroker';

const { transitionEvent, createMcpBrowserEventAdapters } = adaptersModule;
const { createBrowserEventBroker, buildEventContract } = brokerModule;

describe('MCP browser event adapters', () => {
  it('maps stable generic transition evidence without narrative matching', () => {
    expect(transitionEvent('navigation', {
      status: 'confirmed', matched: true, transitionId: 't1', currentUrl: 'https://example.test/next',
      signals: ['url_changed', 'fingerprint_changed'],
    })).toMatchObject({ eventKind: 'navigation', navigated: true, changed: true });
  });

  it('does not call a same-page URL change a popup', () => {
    expect(transitionEvent('popup', {
      status: 'confirmed', matched: true, signals: ['url_changed'], currentUrl: 'https://example.test/next',
    })).toMatchObject({ status: 'inconclusive', reason: 'qaai_popup_event_not_observed' });
  });

  it('arms transition observation before triggering and adopts a new active page', async () => {
    const order = [];
    const mcp = {
      async armPageTransitionObservation() { order.push('arm'); },
      async awaitPageTransitionObservation() {
        order.push('wait');
        return { status: 'confirmed', matched: true, transitionId: 'p2', currentUrl: 'https://example.test/popup', signals: ['new_page', 'active_page_changed'] };
      },
    };
    const broker = createBrowserEventBroker({ adapters: createMcpBrowserEventAdapters({ mcp, session: {} }) });
    const evidence = await broker.execute({
      actionId: 'case:popup:1',
      contract: buildEventContract({ eventKind: 'popup', timeoutMs: 1000 }),
      trigger: async () => { order.push('trigger'); return { isError: false }; },
    });
    expect(order[0]).toBe('arm');
    expect(order.indexOf('trigger')).toBeLessThan(order.indexOf('wait'));
    expect(evidence).toMatchObject({ status: 'confirmed', activePageAdoption: { adopted: true } });
  });

  it('certifies only downloads captured after arming', async () => {
    let rows = [{ id: 'old', suggestedFilename: 'old.csv', sizeBytes: 5, mimeType: 'text/csv' }];
    const watcher = { async listForRunResult() { return rows; } };
    const broker = createBrowserEventBroker({
      adapters: createMcpBrowserEventAdapters({ downloadWatcher: watcher, runResultId: 'rr1' }),
    });
    const evidence = await broker.execute({
      actionId: 'case:download:1',
      contract: buildEventContract({ eventKind: 'download', timeoutMs: 1000, filenamePattern: 'new\\.csv' }),
      trigger: async () => {
        rows = [...rows, { id: 'new', suggestedFilename: 'new.csv', sizeBytes: 20, mimeType: 'text/csv' }];
        return { isError: false };
      },
    });
    expect(evidence).toMatchObject({ status: 'confirmed', selectedEvent: { suggestedFilename: 'new.csv' } });
  });

  it('uses the live session inventory before a RunResult id exists', async () => {
    const session = {};
    let rows = [];
    const watcher = { listLiveForSession() { return rows; } };
    const broker = createBrowserEventBroker({
      adapters: createMcpBrowserEventAdapters({ downloadWatcher: watcher, session }),
    });
    const evidence = await broker.execute({
      actionId: 'case:live-download:1',
      contract: buildEventContract({ eventKind: 'download', timeoutMs: 1000, filenamePattern: 'live\\.pdf' }),
      trigger: async () => {
        rows = [{ id: 'live', suggestedFilename: 'live.pdf', sizeBytes: 100, mimeType: 'application/pdf' }];
        return { isError: false };
      },
    });
    expect(evidence).toMatchObject({ status: 'confirmed', selectedEvent: { suggestedFilename: 'live.pdf' } });
  });

  it('reports missing native chooser support as QAAI uncertainty', async () => {
    const broker = createBrowserEventBroker({ adapters: createMcpBrowserEventAdapters({}) });
    const evidence = await broker.execute({
      actionId: 'case:chooser:1',
      contract: buildEventContract({ eventKind: 'file_chooser', timeoutMs: 5 }),
      trigger: async () => ({ isError: false }),
    });
    expect(evidence).toMatchObject({ status: 'inconclusive', qaaiEvidenceError: true });
  });
});
