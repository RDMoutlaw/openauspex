import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { buildOtsAttestation, isOtsComplete, parseOtsAttestation, stampEventId, upgradeProof } from '../src/ots';
import { KINDS } from '../src/kinds';
import { CanaryParseError } from '../src/errors';
import { sign } from './helpers';

const eventId = 'a'.repeat(64);
const proof = Uint8Array.from([0, 1, 2, 250, 255]);

describe('NIP-03 OTS attestation (kind 1040)', () => {
  it('round-trips build → sign → parse', () => {
    const tmpl = buildOtsAttestation({
      eventId,
      eventKind: KINDS.CANARY_ATTESTATION,
      proof,
      created_at: 1700000000,
    });
    expect(tmpl.kind).toBe(KINDS.OTS_ATTESTATION);
    expect(tmpl.tags).toContainEqual(['e', eventId]);
    expect(tmpl.tags).toContainEqual(['k', String(KINDS.CANARY_ATTESTATION)]);

    const { event } = sign(tmpl);
    const parsed = parseOtsAttestation(event);
    expect(parsed.targetId).toBe(eventId);
    expect(parsed.targetKind).toBe(KINDS.CANARY_ATTESTATION);
    expect(Array.from(parsed.proof)).toEqual([0, 1, 2, 250, 255]);
  });

  it('throws on the wrong kind', () => {
    const { event } = sign({ kind: 1, created_at: 1700000000, content: '', tags: [] });
    expect(() => parseOtsAttestation(event)).toThrow(CanaryParseError);
  });
});

// Opt-in: contacts real OpenTimestamps calendar servers. Enable with LIVE_OTS_TESTS=1.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const LIVE_OTS = Boolean(env?.LIVE_OTS_TESTS);

describe.skipIf(!LIVE_OTS)('live OpenTimestamps', () => {
  it('stamps an event id and the proof survives a serialize round-trip', async () => {
    const stamped = await stampEventId(eventId);
    expect(stamped.length).toBeGreaterThan(0);
    // A freshly stamped proof is still pending; upgrade returns false but must round-trip cleanly.
    const { proof: roundTripped } = await upgradeProof(stamped);
    expect(roundTripped.length).toBeGreaterThan(0);
  }, 30000);
});

describe('isOtsComplete', () => {
  const fixture = (name: string): Uint8Array =>
    new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

  it('returns true for a proof with a complete Bitcoin attestation', () => {
    expect(isOtsComplete(fixture('complete.txt.ots'))).toBe(true);
  });

  it('returns false for a pending (calendar-only) proof', () => {
    expect(isOtsComplete(fixture('incomplete.txt.ots'))).toBe(false);
  });
});
