import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { buildDefinition, parseDefinition } from '../src/definition';
import { buildAttestation, parseAttestation, validateAttestation } from '../src/attestation';
import { KINDS } from '../src/kinds';
import type { BlockAnchor } from '../src/types';
import { sign } from './helpers';

const anchor: BlockAnchor = { height: 847291, hash: 'a'.repeat(64) };

function setup() {
  const skDef = generateSecretKey();
  const pkDef = getPublicKey(skDef);
  const skSigner = generateSecretKey();
  const pkSigner = getPublicKey(skSigner);
  const defEvent = sign(
    buildDefinition({
      id: 'primary',
      content: 'canary',
      cadence: 2592000,
      grace: 604800,
      freshness: { bitcoin: { maxBlockAge: 6 }, ots: true },
      statements: [
        { id: 'no-secret-order', text: 'a' },
        { id: 'no-backdoor', text: 'b' },
      ],
      signers: [pkSigner],
      threshold: 1,
    }),
    skDef,
  ).event;
  return { skDef, pkDef, skSigner, pkSigner, definition: parseDefinition(defEvent) };
}

describe('attestation', () => {
  it('round-trips and validates against its definition', () => {
    const { skSigner, pkDef, definition } = setup();
    const { event } = sign(
      buildAttestation({
        definitionPubkey: pkDef,
        canaryId: 'primary',
        affirms: ['no-secret-order', 'no-backdoor'],
        anchor,
        created_at: 1700000000,
      }),
      skSigner,
    );

    expect(event.kind).toBe(KINDS.CANARY_ATTESTATION);
    const att = parseAttestation(event);
    expect(att.canaryId).toBe('primary');
    expect(att.affirms).toEqual(['no-secret-order', 'no-backdoor']);
    expect(att.anchor).toEqual(anchor);

    expect(validateAttestation(event, { definition }).valid).toBe(true);
  });

  it('rejects an unauthorized signer', () => {
    const { pkDef, definition } = setup();
    const { event } = sign(
      buildAttestation({ definitionPubkey: pkDef, canaryId: 'primary', affirms: ['no-secret-order'], anchor }),
      generateSecretKey(),
    );
    const res = validateAttestation(event, { definition });
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.code === 'unauthorized-signer')).toBe(true);
  });

  it('rejects affirms that reference unknown clauses', () => {
    const { skSigner, pkDef, definition } = setup();
    const { event } = sign(
      buildAttestation({ definitionPubkey: pkDef, canaryId: 'primary', affirms: ['bogus'], anchor }),
      skSigner,
    );
    expect(validateAttestation(event, { definition }).issues.some((i) => i.code === 'unknown-affirm')).toBe(true);
  });

  it('requires a bitcoin anchor when the policy demands one', () => {
    const { skSigner, pkDef, definition } = setup();
    const { event } = sign(
      buildAttestation({ definitionPubkey: pkDef, canaryId: 'primary', affirms: ['no-secret-order'] }),
      skSigner,
    );
    const res = validateAttestation(event, { definition });
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.code === 'missing-anchor')).toBe(true);
  });

  it('accepts a single-author canary with no explicit signers', () => {
    const skDef = generateSecretKey();
    const pkDef = getPublicKey(skDef);
    const defEvent = sign(
      buildDefinition({
        id: 'solo',
        content: 'c',
        cadence: 86400,
        grace: 3600,
        freshness: { bitcoin: { maxBlockAge: 6 } },
        statements: [{ id: 'all-clear', text: 'all clear' }],
      }),
      skDef,
    ).event;
    const definition = parseDefinition(defEvent);
    const { event } = sign(
      buildAttestation({ definitionPubkey: pkDef, canaryId: 'solo', affirms: ['all-clear'], anchor }),
      skDef,
    );
    expect(validateAttestation(event, { definition }).valid).toBe(true);
  });
});
