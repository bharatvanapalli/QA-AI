import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repositoryModule = require('../../server/services/actionTransactionRepository.js');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-action-transaction-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('durable action transaction repository', () => {
  it('recovers a privacy-safe transaction across repository instances without raw identity paths', async () => {
    const identity = { runId: 'run-sensitive-name', caseId: 'case-sensitive-name', stepId: 'password-step', sequenceIndex: 2 };
    const transaction = {
      schemaVersion: 1,
      transactionId: 'transaction-1',
      action: { kind: 'fill', target: 'Password', value: 'literal-secret', valueRef: 'credential.password' },
      dispatchStatus: 'dispatching',
      dispatchAttemptCount: 1,
    };
    const first = repositoryModule.createActionTransactionRepository({ rootDir: root });
    await first.saveTransaction(identity, transaction);
    const recordPath = first.recordPath('transaction', identity);
    expect(recordPath).not.toContain(identity.runId);
    expect(recordPath).not.toContain(identity.caseId);
    expect(recordPath).not.toContain(identity.stepId);
    expect(fs.readFileSync(recordPath, 'utf8')).not.toContain('literal-secret');

    const restarted = repositoryModule.createActionTransactionRepository({ rootDir: root });
    const loaded = await restarted.loadTransaction(identity);
    expect(loaded).toMatchObject({
      transactionId: 'transaction-1',
      dispatchStatus: 'dispatching',
      dispatchAttemptCount: 1,
      action: { kind: 'fill', valueRef: 'credential.password' },
    });
    expect(loaded.action).not.toHaveProperty('value');
  });

  it('atomically overwrites and reloads only the whitelisted occurrence state', async () => {
    const repository = repositoryModule.createActionTransactionRepository({ rootDir: root });
    const identity = { runId: 'run-1', caseId: 'case-1', occurrenceKey: 'save::submit' };
    const base = {
      schemaVersion: 'qaai-action-execution-occurrence-v1',
      occurrenceKey: 'save::submit',
      actionOccurrenceId: 'save',
      mutationPhaseId: 'submit',
      toolName: 'browser_click',
      argsDigest: 'args-hash',
      status: 'dispatch_started',
      dispatchAttemptCount: 1,
      args: { password: 'must-not-persist' },
    };
    await repository.saveOccurrence(identity, base);
    await repository.saveOccurrence(identity, { ...base, status: 'committed', committedAt: 42 });
    const loaded = await repository.loadOccurrence(identity);
    expect(loaded).toMatchObject({ status: 'committed', committedAt: 42, dispatchAttemptCount: 1 });
    expect(loaded).not.toHaveProperty('args');
    const directory = path.dirname(repository.recordPath('occurrence', identity));
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('retries a transient Windows rename lock instead of aborting the run', async () => {
    const source = path.join(root, 'source.tmp');
    const target = path.join(root, 'target.json');
    fs.writeFileSync(source, '{"ok":true}', 'utf8');
    const originalRename = fs.promises.rename.bind(fs.promises);
    let attempts = 0;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('temporarily locked');
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(...args);
    });

    try {
      await repositoryModule.renameWithTransientLockRetry(source, target, {
        maxAttempts: 4,
        initialDelayMs: 1,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(attempts).toBe(3);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true}');
  });
});
