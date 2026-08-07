import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('output readiness UI contract', () => {
  const source = fs.readFileSync('src/pages/OutputFiles.jsx', 'utf8');
  const routeSource = fs.readFileSync('server/routes/outputFiles.js', 'utf8');

  it('never renders a green legacy ReplayIR-ready fallback', () => {
    expect(source).not.toMatch(/>\s*ReplayIR ready\s*</);
    expect(source).toContain('Generated - status unavailable');
    expect(source).toContain('Generated - validation pending');
  });

  it('requires explicit certified readiness and marks stale script reports', () => {
    expect(source).toContain("preparation.status === 'ready' && preparation.certified === true");
    expect(source).toContain("Generated - not run");
    expect(source).toContain("Files remain downloadable.");
    expect(routeSource).toContain('downloadable: readiness.downloadable');
    expect(routeSource).toContain('runnable: readiness.runnable');
    expect(routeSource).toContain('certified: readiness.certified');
    expect(source).toContain("current={outputPreparation?.validationCurrent}");
    expect(source).toContain("current === false ? 'stale'");
  });

  it('renders legacy safety status as a nonblocking diagnostic without changing output controls', () => {
    expect(source).not.toContain('Safety blocked');
    expect(source).not.toContain('Output blocked');
    expect(source).toContain('Generated with diagnostics');
    expect(source).toContain('Nonblocking diagnostic:');
    expect(source).toContain('Generated files remain visible');

    expect(source).toContain('disabled={empty}');
    expect(source).not.toContain('disabled={empty || exportBlocked}');
    expect(source).toContain('disabled={empty || scriptRunBusy}');
    expect(source).toContain('disabled={empty || savingFolder}');
    expect(source).toContain('disabled={empty || vscodeBusy}');
  });

  it('contains valid UTF-8 separators without mojibake', () => {
    expect(source).toContain('No outputs yet — kick off a run from Test Cases.');
    expect(source).toContain("`${stats.files} file${stats.files === 1 ? '' : 's'} · ${stats.dirs} folder");
    expect(source).not.toMatch(/Â·|â€”|â€¦/);
  });

  it('compares validation proof with the exact current hardened package hash', () => {
    expect(routeSource).toContain('scriptValidationRunner.hardenPlaywrightPackageFiles(files');
    expect(routeSource).toContain('currentPackageHash');
    expect(routeSource).toContain('currentBundleId');
    expect(routeSource).toContain('validationPackageHashMatches');
  });

  it('always serves the generated file tree even when output findings include a secret', () => {
    expect(routeSource).not.toContain('const refusal = replayRefusalPayload(workspace);');
    expect(routeSource).not.toContain(
      'if (refusal) return res.status(refusal.status).json(refusal.body);',
    );
    expect(routeSource).not.toContain(
      "return res.status(422).json({ success: false, code: 'SECRET_LEAK'",
    );
    expect(routeSource).not.toContain('Certified export refused because a secret literal appeared in the package.');
    expect(routeSource).not.toContain('function replayRefusalPayload');
    expect(routeSource).toContain('const root = treeFromFiles(workspace.files');
    expect(routeSource).toContain('findings: workspace.result.findings || []');
    expect(routeSource).toContain('exportBlocked: false');
  });

  it('keeps download, save-to-folder, and open-in-vscode access independent from package validation', () => {
    expect(routeSource).toMatch(
      /buildReplayExport\(\{\s*projectId: project\.id,\s*runId: reqRunId,\s*runResultIds,\s*generationId,\s*framework,\s*validate: false,\s*\}\)/,
    );
    expect(routeSource).toMatch(
      /router\.get\('\/files\.json'[\s\S]*?buildReplayWorkspace\(req, project, \{ validate: false \}\)/,
    );
    expect(routeSource).toMatch(
      /router\.post\('\/open-in-vscode'[\s\S]*?buildReplayWorkspace\(req, project, \{ validate: false \}\)/,
    );
    expect(routeSource).not.toMatch(
      /router\.get\('\/files\.json'[\s\S]*?buildReplayWorkspace\(req, project, \{ validate: true \}\)/,
    );
    expect(routeSource).not.toMatch(
      /router\.post\('\/open-in-vscode'[\s\S]*?buildReplayWorkspace\(req, project, \{ validate: true \}\)/,
    );
  });
});
