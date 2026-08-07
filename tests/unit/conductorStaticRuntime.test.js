import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const require = createRequire(import.meta.url);
const {
  deadlineForOperation,
  observationAttemptsForOperation,
  outcomeAllowsContinuation,
} = require('../../server/services/agents/controllerConductor');
const legacyRuntimePath = path.resolve(root, 'server/services/agents/conductor.js');
const frozenConductorPath = path.resolve(root, '.qaai-migration/runtime-freeze/conductor.materialized.candidate.js');
const controllerConductorPath = path.resolve(root, 'server/services/agents/controllerConductor.js');
const pinnedPath = path.resolve(root, 'server/services/agents/conductorPinned.js');
const manifestPath = path.resolve(root, '.qaai-migration/runtime-freeze/manifest.json');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();

describe('reviewed static Conductor runtime', () => {
  it('executes the reviewed controller source without a runtime transformer or legacy runtime', () => {
    const pinned = fs.readFileSync(pinnedPath, 'utf8');
    expect(fs.existsSync(legacyRuntimePath)).toBe(false);
    expect(pinned).toContain("require('./controllerConductor')");
    expect(pinned).not.toContain("require('./conductor')");
    expect(pinned).not.toContain('conductorRuntimeLoader');
    expect(pinned).not.toContain('loadConductorRuntime');
  });

  it('matches the frozen materialized candidate exactly', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const conductor = fs.readFileSync(frozenConductorPath, 'utf8');
    expect(Buffer.byteLength(conductor)).toBe(manifest.materialized.bytes);
    expect(sha256(conductor)).toBe(manifest.materialized.sha256);
  });

  it('is syntax-valid CommonJS', () => {
    const conductor = fs.readFileSync(frozenConductorPath, 'utf8');
    expect(() => new vm.Script(Module.wrap(conductor), {
      filename: frozenConductorPath,
      displayErrors: true,
    })).not.toThrow();
    const controllerConductor = fs.readFileSync(controllerConductorPath, 'utf8');
    expect(() => new vm.Script(Module.wrap(controllerConductor), {
      filename: controllerConductorPath,
      displayErrors: true,
    })).not.toThrow();
  });

  it('keeps raw browser transport behind the gateway-owned adapter boundary', () => {
    const runtimeFiles = [
      'server/services/browserTransactionController.js',
      'server/services/controllerRecoveryCoordinator.js',
      'server/services/controllerCompositeExecutor.js',
      'server/services/agents/controllerConductor.js',
    ];
    for (const relativePath of runtimeFiles) {
      const source = fs.readFileSync(path.resolve(root, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/(?:mcp\.)?callTool\s*\(/);
      expect(source, relativePath).not.toMatch(/session\.client\.callTool\s*\(/);
    }
    const adapter = fs.readFileSync(
      path.resolve(root, 'server/services/controllerMcpRuntimeAdapter.js'),
      'utf8',
    );
    expect((adapter.match(/session\.client\.callTool\s*\(/g) || [])).toHaveLength(1);
    expect(adapter).toContain('CONTROLLER_MCP_GATEWAY_AUTHORIZATION_REQUIRED');
  });

  it('keeps fast-path actions immediate while bounding slow first-load target resolution', () => {
    expect(deadlineForOperation({ type: 'WaitForState' })).toBe(20_000);
    expect(observationAttemptsForOperation({ type: 'WaitForState' })).toBe(18);
    expect(deadlineForOperation({ type: 'Fill' })).toBe(30_000);
    expect(observationAttemptsForOperation({ type: 'Fill' })).toBe(6);
    expect(deadlineForOperation({
      type: 'Click',
      operationCheck: { kind: 'page_ready' },
    })).toBe(30_000);
    expect(deadlineForOperation({
      type: 'Click',
      operationCheck: { kind: 'menu_opened' },
    })).toBe(10_000);
  });

  it('hands off a live session from continuation facts instead of the validation verdict', () => {
    expect(outcomeAllowsContinuation({
      paused: false,
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{ scheduleState: 'TERMINAL' }],
      },
      operationResults: [{
        terminalDecision: {
          state: 'ASSERTION_FAILED',
          continuation: { terminationReason: null },
        },
      }],
    })).toBe(true);
    expect(outcomeAllowsContinuation({
      paused: false,
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{ scheduleState: 'TERMINAL' }],
      },
      operationResults: [{
        terminalDecision: {
          state: 'EXECUTION_ERROR',
          continuation: {
            disposition: 'CONTINUE',
            skipDependents: false,
            terminationReason: null,
          },
        },
      }],
    })).toBe(true);
    expect(outcomeAllowsContinuation({
      paused: false,
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{ scheduleState: 'SKIPPED_DEPENDENCY' }],
      },
      operationResults: [{
        terminalDecision: {
          state: 'EXECUTION_ERROR',
          continuation: {
            terminationReason: 'REQUIRED_MUTATION_PROVEN_UNDELIVERED',
          },
        },
      }],
    })).toBe(false);
  });
});
