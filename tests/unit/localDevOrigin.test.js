import { describe, expect, it } from 'vitest';
import { alignLoopbackUrlWithPage } from '../../src/lib/localDevOrigin';

describe('alignLoopbackUrlWithPage', () => {
  it('keeps localhost API calls on localhost pages', () => {
    const pageLocation = new URL('http://localhost:5173/project-setup');
    expect(alignLoopbackUrlWithPage('http://localhost:5000/api', undefined, pageLocation)).toBe('http://localhost:5000/api');
  });

  it('rewrites localhost API calls to 127.0.0.1 when the app is opened on 127.0.0.1', () => {
    const pageLocation = new URL('http://127.0.0.1:5173/project-setup');
    expect(alignLoopbackUrlWithPage('http://localhost:5000/api', undefined, pageLocation)).toBe('http://127.0.0.1:5000/api');
    expect(alignLoopbackUrlWithPage('ws://localhost:5000', undefined, pageLocation)).toBe('ws://127.0.0.1:5000');
  });

  it('does not rewrite non-loopback hosts', () => {
    const pageLocation = new URL('https://qaai.example.com/project-setup');
    expect(alignLoopbackUrlWithPage('https://api.example.com/api', undefined, pageLocation)).toBe('https://api.example.com/api');
  });
});
