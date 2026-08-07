import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sourceGrounding = require('../../server/services/sourceGrounding');
const { decodeJson } = require('../../server/services/jsonField');

describe('source grounding', () => {
  afterEach(() => {
    delete process.env.QAAI_FIRECRAWL_INTAKE_ENABLED;
    delete process.env.QAAI_FIRECRAWL_LIVE_CRAWL_ENABLED;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_URL;
    delete process.env.QAAI_FIRECRAWL_TIMEOUT_MS;
    delete process.env.QAAI_FIRECRAWL_POLL_INTERVAL_MS;
  });

  it('stores Firecrawl artifacts as discovered, redacted, project-scoped source context', async () => {
    process.env.QAAI_FIRECRAWL_INTAKE_ENABLED = '1';
    const created = [];
    const prisma = {
      sourceArtifact: {
        create: async ({ data }) => {
          const row = { id: `artifact-${created.length + 1}`, ...data };
          created.push(row);
          return row;
        },
      },
    };

    const result = await sourceGrounding.ingestFirecrawlSourceArtifacts({
      prisma,
      projectId: 'project-1',
      artifacts: [{
        sourceUrl: 'https://example.test/help',
        tenantAllowed: true,
        robotsPolicy: 'allow',
        content: 'Users must see a validation message. api_key=super-secret-value Submit button saves the form.',
      }],
    });

    expect(result.artifacts).toHaveLength(1);
    expect(created[0]).toMatchObject({
      projectId: 'project-1',
      generationId: null,
      source: 'firecrawl',
      confidence: 'discovered',
      verifiedByPlaywright: false,
      tenantAllowed: true,
    });
    expect(created[0].content).toContain('api_key=<redacted>');
    expect(decodeJson(created[0].artifactJson, {})).toMatchObject({
      source: 'firecrawl',
      confidence: 'discovered',
      verifiedByPlaywright: false,
    });
    expect(sourceGrounding.sourceArtifactsToRequirementClauses(result.artifacts)[0]).toMatchObject({
      source: 'firecrawl',
      confidence: 'discovered',
      verifiedByPlaywright: false,
      sourceArtifactId: 'artifact-1',
    });
  });

  it('attaches Firecrawl evidence only to cases that cite Firecrawl clauses', () => {
    const scenarios = [{
      name: 'Scenario',
      cases: [
        { name: 'Cites Firecrawl', requirementRefs: ['firecrawl:artifact-1:requirement:1'] },
        { name: 'Uploaded requirement only', requirementRefs: ['req-1'] },
      ],
    }];

    const result = sourceGrounding.attachSourceArtifactsToCases(scenarios, [{
      id: 'artifact-1',
      source: 'firecrawl',
      confidence: 'discovered',
      verifiedByPlaywright: false,
      freshness: 'fresh',
      tenantAllowed: true,
    }]);

    expect(result[0].cases[0].sourceArtifacts).toMatchObject([
      { source: 'firecrawl', confidence: 'discovered', verifiedByPlaywright: false },
    ]);
    expect(result[0].cases[1].sourceArtifacts).toBeUndefined();
  });

  it('normalizes only public HTTP source URLs for live Firecrawl crawling', () => {
    const urls = sourceGrounding.normalizeFirecrawlUrls([
      'https://docs.example.test/help#install',
      'http://localhost:5000/internal',
      'file:///tmp/secrets',
      'https://docs.example.test/help#different-fragment',
      'http://192.168.0.5/admin',
    ], { maxUrls: 5 });

    expect(urls).toEqual(['https://docs.example.test/help']);
  });

  it('live-crawls public URLs only when enabled and stores discovered unverified artifacts', async () => {
    process.env.QAAI_FIRECRAWL_LIVE_CRAWL_ENABLED = '1';
    process.env.FIRECRAWL_API_KEY = 'test-key';
    process.env.QAAI_FIRECRAWL_TIMEOUT_MS = '5000';
    process.env.QAAI_FIRECRAWL_POLL_INTERVAL_MS = '1';
    const created = [];
    const requests = [];
    const prisma = {
      sourceArtifact: {
        create: async ({ data }) => {
          const row = { id: `artifact-${created.length + 1}`, ...data };
          created.push(row);
          return row;
        },
      },
    };
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      if (String(url).endsWith('/crawl') && options.method === 'POST') {
        expect(options.headers.Authorization).toBe('Bearer test-key');
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, id: 'crawl-1' }) };
      }
      if (String(url).endsWith('/crawl/crawl-1')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            status: 'completed',
            total: 1,
            completed: 1,
            data: [{
              markdown: 'Users must see the Save button. Expected validation message appears after invalid input.',
              metadata: { title: 'Help', sourceURL: 'https://docs.example.test/help' },
            }],
          }),
        };
      }
      throw new Error(`unexpected request ${url}`);
    };

    const result = await sourceGrounding.crawlFirecrawlSourceUrls({
      prisma,
      projectId: 'project-1',
      urls: ['https://docs.example.test/help', 'http://localhost:3000/private'],
      fetchImpl,
    });

    expect(result.skipped).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: 'firecrawl',
      confidence: 'discovered',
      verifiedByPlaywright: false,
      tenantAllowed: true,
      robotsPolicy: 'respected',
      sourceUrl: 'https://docs.example.test/help',
    });
    expect(requests.some((req) => String(req.url).includes('localhost'))).toBe(false);
  });
});
