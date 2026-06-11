import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { buildDefinition, parseDefinition, validateDefinition } from '../src/definition';
import { KINDS } from '../src/kinds';
import type { BuildDefinitionParams } from '../src/definition';
import { sign } from './helpers';

const baseParams = (pk: string): BuildDefinitionParams => ({
  id: 'primary',
  content: 'Test canary',
  cadence: 2592000,
  grace: 604800,
  freshness: { bitcoin: { maxBlockAge: 6 }, ots: true },
  statements: [
    { id: 'no-secret-order', text: 'We have not received any secret order.' },
    { id: 'no-backdoor', text: 'We have not installed a backdoor.' },
  ],
  signers: [pk],
  threshold: 1,
  title: 'Test — Primary',
});

describe('definition', () => {
  it('round-trips build → sign → parse', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const { event } = sign(buildDefinition({ ...baseParams(pk), created_at: 1700000000 }), sk);

    expect(event.kind).toBe(KINDS.CANARY_DEFINITION);
    const def = parseDefinition(event);
    expect(def.id).toBe('primary');
    expect(def.cadence).toBe(2592000);
    expect(def.grace).toBe(604800);
    expect(def.freshness.bitcoin?.maxBlockAge).toBe(6);
    expect(def.freshness.ots).toBe(true);
    expect(def.statements.map((s) => s.id)).toEqual(['no-secret-order', 'no-backdoor']);
    expect(def.signers).toEqual([pk]);
    expect(def.threshold).toBe(1);
  });

  it('validates a well-formed definition', () => {
    const sk = generateSecretKey();
    const { event } = sign(buildDefinition(baseParams(getPublicKey(sk))), sk);
    const res = validateDefinition(event);
    expect(res.valid).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('rejects a tampered signature', () => {
    const sk = generateSecretKey();
    const { event } = sign(buildDefinition(baseParams(getPublicKey(sk))), sk);
    // Simulate an event as received from a relay (plain JSON, without nostr-tools' cached
    // verification symbol) and then tamper with it: the recomputed id no longer matches the
    // signature, so validation must fail.
    const tampered = JSON.parse(JSON.stringify(event));
    tampered.content = 'mutated';
    const res = validateDefinition(tampered);
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.code === 'bad-signature')).toBe(true);
  });

  it('flags duplicate statement ids', () => {
    const sk = generateSecretKey();
    const params = baseParams(getPublicKey(sk));
    params.statements = [
      { id: 'dup', text: 'one' },
      { id: 'dup', text: 'two' },
    ];
    const { event } = sign(buildDefinition(params), sk);
    const res = validateDefinition(event);
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.code === 'duplicate-statement')).toBe(true);
  });

  it('flags a threshold that exceeds the signer count', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const { event } = sign(buildDefinition({ ...baseParams(pk), threshold: 3, signers: [pk] }), sk);
    const res = validateDefinition(event);
    expect(res.issues.some((i) => i.code === 'threshold-too-high')).toBe(true);
  });

  it('flags a missing cadence tag', () => {
    const sk = generateSecretKey();
    const { event } = sign(
      {
        kind: KINDS.CANARY_DEFINITION,
        created_at: 1700000000,
        content: 'x',
        tags: [
          ['d', 'primary'],
          ['grace', '604800'],
        ],
      },
      sk,
    );
    const res = validateDefinition(event);
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.code === 'bad-cadence')).toBe(true);
  });
});
