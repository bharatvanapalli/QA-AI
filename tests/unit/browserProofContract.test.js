import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const proof = require('../../server/services/browserProofContract');

describe('browser proof contract', () => {
  it('accepts any exact authored proof alternative', () => {
    const contract = proof.createProofContract({
      id: 'click-sign-in',
      alternatives: [
        { id: 'authored-destination', allOf: ['destination_visible'] },
        { id: 'next-required-control', allOf: ['password_actionable'] },
      ],
    });
    expect(proof.evaluateAnyOfProof(contract, [{
      claimId: 'password_actionable',
      status: proof.PROOF_STATUS.MATCHED,
      tier: proof.EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
      source: 'live_owner',
      factRef: 'control:password',
    }])).toMatchObject({
      status: proof.PROOF_STATUS.MATCHED,
      matchedAlternativeId: 'next-required-control',
    });
  });

  it('does not let a missing browser event veto exact destination truth', () => {
    const contract = proof.createProofContract({
      id: 'click-sign-in',
      alternatives: [{ id: 'next-required-control', allOf: ['password_actionable'] }],
    });
    expect(proof.evaluateAnyOfProof(contract, [{
      claimId: 'password_actionable',
      status: proof.PROOF_STATUS.MATCHED,
      tier: proof.EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
      source: 'live_owner',
    }, {
      claimId: 'password_actionable',
      status: proof.PROOF_STATUS.MISMATCH,
      tier: proof.EVIDENCE_TIER.BROWSER_EVENT,
      source: 'event_recorder',
    }]).status).toBe(proof.PROOF_STATUS.MATCHED);
  });

  it('keeps equal-precedence contradictions unknown for reconciliation', () => {
    const contract = proof.createProofContract({
      id: 'email-fill',
      alternatives: [{ id: 'owner-readback', allOf: ['email_value'] }],
    });
    expect(proof.evaluateAnyOfProof(contract, [{
      claimId: 'email_value',
      status: proof.PROOF_STATUS.MATCHED,
      tier: proof.EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
      source: 'playwright_owner',
    }, {
      claimId: 'email_value',
      status: proof.PROOF_STATUS.MISMATCH,
      tier: proof.EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
      source: 'dom_owner',
    }]).status).toBe(proof.PROOF_STATUS.UNKNOWN);
  });
});
