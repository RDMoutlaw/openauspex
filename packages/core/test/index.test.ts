import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

// Import via the public package name to confirm the workspace symlink + `exports` map resolve.
import {
  KINDS,
  buildAttestation,
  buildDefinition,
  parseDefinition,
  validateAttestation,
  validateDefinition,
} from '@openauspex/core';

import { sign } from './helpers';

describe('public entry (@openauspex/core)', () => {
  it('exposes a working build → sign → validate round-trip', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);

    const defEvent = sign(
      buildDefinition({
        id: 'primary',
        content: 'canary',
        cadence: 2592000,
        grace: 604800,
        freshness: { bitcoin: { maxBlockAge: 6 }, ots: true },
        statements: [{ id: 'all-clear', text: 'all clear' }],
      }),
      sk,
    ).event;
    expect(defEvent.kind).toBe(KINDS.CANARY_DEFINITION);
    expect(validateDefinition(defEvent).valid).toBe(true);

    const definition = parseDefinition(defEvent);
    const attEvent = sign(
      buildAttestation({
        definitionPubkey: pk,
        canaryId: 'primary',
        affirms: ['all-clear'],
        anchor: { height: 847291, hash: 'a'.repeat(64) },
      }),
      sk,
    ).event;

    expect(validateAttestation(attEvent, { definition }).valid).toBe(true);
  });
});
