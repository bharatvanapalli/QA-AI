import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('server/routes/agents.js'), 'utf8');
const contractSource = fs.readFileSync(path.resolve('server/services/pipelineContract.js'), 'utf8');

describe('agent rewrite guard', () => {
  it('does not auto-apply critic or supervisor test case rewrites by default', () => {
    expect(source).toContain('pipelineContract.autoApplyAgentRewritesEnabled()');
    expect(contractSource).toContain('QAAI_AUTO_APPLY_AGENT_REWRITES');
    expect(contractSource).toContain('diagnose_and_suggest_only');
    expect(source).toContain('AUTO_APPLY_AGENT_REWRITES');
    expect(source).toContain('Critic suggested');
    expect(source).toContain('did not auto-apply them');
    expect(source).toContain('Supervisor suggested a revised case');
    expect(source).toContain('appliedRewriteCount');
    expect(source).toContain('appliedSupervisorRevisionCount');
  });
});
