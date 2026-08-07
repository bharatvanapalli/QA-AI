const mcp = require('../../server/services/mcp');

function fakeFrame(url, events, { fail = false } = {}) {
  return {
    url: () => url,
    evaluate: vi.fn(async (source) => {
      if (fail) throw new Error('frame unavailable');
      if (String(source).includes("typeof recorder.drain")) return events;
      return { installed: true, reused: true };
    }),
  };
}

function fakePage(url, frames, screenshot = null) {
  return {
    isClosed: () => false,
    url: () => url,
    frames: () => frames,
    viewportSize: () => ({ width: 1280, height: 720 }),
    screenshot: screenshot || vi.fn(async () => Buffer.from('image-bytes')),
  };
}

describe('MCP in-page browser-event capture', () => {
  test('drains every live frame and returns events in browser-time order', async () => {
    const main = fakeFrame('https://example.test/', [
      { eventId: 'late', type: 'click', at: 20, sequence: 2, target: { tagName: 'button' } },
    ]);
    const child = fakeFrame('https://example.test/frame', [
      { eventId: 'early', type: 'input', at: 10, sequence: 1, target: { tagName: 'input' } },
    ]);
    const page = fakePage('https://example.test/', [main, child]);
    const session = { liveCdp: { context: { pages: () => [page] } } };

    const captured = await mcp.captureInPageBrowserEvents(session, { timeoutMs: 100 });

    expect(captured).toMatchObject({
      pageCount: 1,
      frameCount: 2,
      recorderFrameCount: 2,
      captureErrorCount: 0,
      mode: 'drain',
    });
    expect(captured.events.map((event) => event.eventId)).toEqual(['early', 'late']);
    expect(main.evaluate).toHaveBeenCalledTimes(2);
    expect(child.evaluate).toHaveBeenCalledTimes(2);
    expect(session.actionExecutionGatewayTrail).toHaveLength(2);
    expect(session.actionExecutionGatewayTrail.every((entry) =>
      entry.toolName === 'playwright_frame_install_event_recorder'
      && entry.browserAdapter === true
      && !Object.prototype.hasOwnProperty.call(entry, 'args'))).toBe(true);
  });

  test('keeps healthy frame evidence when another frame cannot be inspected', async () => {
    const healthy = fakeFrame('https://example.test/', [
      { eventId: 'click-1', type: 'click', at: 1, sequence: 1, target: { tagName: 'button' } },
    ]);
    const unavailable = fakeFrame('https://third-party.test/', [], { fail: true });
    const page = fakePage('https://example.test/', [healthy, unavailable]);
    const session = { liveCdp: { context: { pages: () => [page] } } };

    const captured = await mcp.captureInPageBrowserEvents(session, { timeoutMs: 100 });

    expect(captured.events).toHaveLength(1);
    expect(captured.recorderFrameCount).toBe(1);
    expect(captured.captureErrorCount).toBe(1);
  });

  test('captures a bounded owner-page screenshot without persisting during probes', async () => {
    const page = fakePage('https://example.test/', []);
    const session = { liveCdp: { context: { pages: () => [page] } } };

    const captured = await mcp.captureLiveEvidenceScreenshot(session, {
      timeoutMs: 100,
      persist: false,
    });

    expect(captured).toMatchObject({
      artifactRef: null,
      width: 1280,
      height: 720,
      redacted: false,
      bytes: Buffer.byteLength('image-bytes'),
    });
    expect(captured.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(page.screenshot).toHaveBeenCalledTimes(1);
  });
});
