import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const postPersistVerification = require('../../server/services/reliability/postPersistVerification');

describe('post-persist generation visibility policy', () => {
  it('reports contract metadata drift without deleting authored cases', () => {
    for (const code of [
      'quality_contract_missing',
      'readiness_contract_missing',
      'readiness_status_mismatch',
      'session_mode_mismatch',
      'failure_policy_mismatch',
      'row_coverage_status_mismatch',
      'execution_contract_invalid',
      'selection_value_polluted',
      'condition_contains_browser_action',
      'malformed_control_target',
    ]) {
      expect(postPersistVerification.isPostPersistBlockingDefect(code)).toBe(false);
    }
  });

  it('still rejects persisted step payloads that cannot be represented safely', () => {
    for (const code of [
      'invalid_steps_shape',
      'malformed_steps_json',
      'non_array_steps',
      'post_persist_verification_failed',
    ]) {
      expect(postPersistVerification.isPostPersistBlockingDefect(code)).toBe(true);
    }
  });
});
