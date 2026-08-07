import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function legacyPostRouteSource() {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'server/routes/runs.js'),
    'utf8',
  );
  const start = source.indexOf("router.post('/', requireCsrf");
  const end = source.indexOf("router.get('/',", start);
  if (start < 0 || end < 0) throw new Error('legacy POST /api/runs boundary not found');
  return source.slice(start, end);
}

describe('live execution authority', () => {
  it('routes selected legacy runs to Conductor without invoking the worker engine', () => {
    const route = legacyPostRouteSource();

    expect(route).toContain("res.set('X-QAAI-Execution-Authority', 'conductor')");
    expect(route).toContain('res.redirect(');
    expect(route).toContain('307');
    expect(route).toContain('/agents/run-smoke');
    expect(route).not.toContain('runs.startRun');
    expect(route).not.toContain('runPlaywright');
    expect(route).not.toContain('playwright-worker');
  });
});
