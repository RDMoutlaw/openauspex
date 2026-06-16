import { describe, expect, it } from 'vitest';

import { diffDefinitions, evaluate } from '../src/evaluate';
import type { EvaluatedAttestation } from '../src/evaluate';
import type { CanaryDefinition } from '../src/types';

const DAY = 86400;

function definition(overrides: Partial<CanaryDefinition> = {}): CanaryDefinition {
  return {
    id: 'primary',
    pubkey: 'p'.repeat(64),
    content: '',
    cadence: 30 * DAY,
    grace: 7 * DAY,
    freshness: { bitcoin: { maxBlockAge: 6 }, ots: true },
    statements: [
      { id: 'no-secret-order', text: 'a' },
      { id: 'no-backdoor', text: 'b' },
    ],
    signers: ['a'.repeat(64)],
    threshold: 1,
    ...overrides,
  };
}

function att(overrides: Partial<EvaluatedAttestation> = {}): EvaluatedAttestation {
  return {
    eventId: 'e'.repeat(64),
    signer: 'a'.repeat(64),
    status: 'alive',
    affirms: ['no-secret-order', 'no-backdoor'],
    anchorTime: 1_000_000,
    valid: true,
    ...overrides,
  };
}

describe('evaluate', () => {
  it('reports unknown when there are no valid attestations', () => {
    const res = evaluate(definition(), [], { now: 1_000_000 });
    expect(res.state).toBe('unknown');
  });

  it('reports alive within cadence + grace', () => {
    const a = att({ anchorTime: 1_000_000 });
    const res = evaluate(definition(), [a], { now: 1_000_000 + 10 * DAY });
    expect(res.state).toBe('alive');
    expect(res.freshSigners).toEqual(['a'.repeat(64)]);
    expect(res.deadline).toBe(1_000_000 + 37 * DAY);
  });

  it('reports dead past cadence + grace', () => {
    const a = att({ anchorTime: 1_000_000 });
    const res = evaluate(definition(), [a], { now: 1_000_000 + 40 * DAY });
    expect(res.state).toBe('dead');
    expect(res.alarms.some((x) => x.kind === 'dead')).toBe(true);
  });

  it('ignores invalid and unauthorized attestations for liveness', () => {
    const forged = att({ signer: 'z'.repeat(64), anchorTime: 1_000_000 + 39 * DAY });
    const tampered = att({ valid: false, anchorTime: 1_000_000 + 39 * DAY });
    const res = evaluate(definition(), [forged, tampered], { now: 1_000_000 + 40 * DAY });
    expect(res.state).toBe('unknown'); // neither counts
  });

  it('raises a clause-drop alarm naming the dropped clause and signer', () => {
    const signer = 'a'.repeat(64);
    const first = att({ eventId: '1'.repeat(64), anchorTime: 1_000_000, affirms: ['no-secret-order', 'no-backdoor'] });
    const second = att({ eventId: '2'.repeat(64), anchorTime: 1_000_000 + 30 * DAY, affirms: ['no-secret-order'] });
    const res = evaluate(definition(), [first, second], { now: 1_000_000 + 31 * DAY });
    expect(res.state).toBe('alive');
    const drop = res.alarms.find((x) => x.kind === 'clause-drop');
    expect(drop?.clause).toBe('no-backdoor');
    expect(drop?.signer).toBe(signer);
    expect(drop?.eventId).toBe('2'.repeat(64));
  });

  it('reports a graceful retirement', () => {
    const a = att({ status: 'retired', anchorTime: 1_000_000 });
    const res = evaluate(definition(), [a], { now: 1_000_000 + 10 * DAY });
    expect(res.state).toBe('retired');
  });

  describe('m-of-n', () => {
    const signers = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const def = definition({ signers, threshold: 2 });

    it('is alive when at least the threshold of signers are fresh', () => {
      const now = 1_000_000 + 10 * DAY;
      const atts = [
        att({ signer: signers[0]!, anchorTime: 1_000_000 }),
        att({ signer: signers[1]!, anchorTime: 1_000_000 }),
      ];
      const res = evaluate(def, atts, { now });
      expect(res.state).toBe('alive');
      expect(res.freshSigners).toHaveLength(2);
    });

    it('is dead when fewer than the threshold of signers are fresh', () => {
      const now = 1_000_000 + 40 * DAY;
      const atts = [
        att({ signer: signers[0]!, anchorTime: 1_000_000 + 39 * DAY }), // fresh
        att({ signer: signers[1]!, anchorTime: 1_000_000 }), // stale
      ];
      const res = evaluate(def, atts, { now });
      expect(res.state).toBe('dead');
      expect(res.freshSigners).toEqual([signers[0]]);
    });
  });
});

describe('back-dating (OTS upper bound)', () => {
  it('raises no alarm when the OTS commit is within tolerance of the anchor', () => {
    const a = att({ anchorTime: 1_000_000, otsTime: 1_000_000 + 3600 }); // stamped ~1h after anchor
    const res = evaluate(definition(), [a], { now: 1_000_000 + 10 * DAY });
    expect(res.alarms.some((x) => x.kind === 'back-dated')).toBe(false);
  });

  it('flags an attestation anchored long before its OTS commit (a back-filled period)', () => {
    const a = att({ eventId: 'b'.repeat(64), anchorTime: 1_000_000, otsTime: 1_000_000 + 30 * DAY });
    const res = evaluate(definition(), [a], { now: 1_000_000 + 31 * DAY });
    expect(res.state).toBe('alive'); // anchor still within cadence+grace — liveness is unaffected
    const flag = res.alarms.find((x) => x.kind === 'back-dated');
    expect(flag?.eventId).toBe('b'.repeat(64));
    expect(flag?.signer).toBe('a'.repeat(64));
  });

  it('flags an OTS commit that precedes the anchor block (inconsistent bounds)', () => {
    const a = att({ anchorTime: 1_000_000, otsTime: 1_000_000 - 5 * DAY });
    const res = evaluate(definition(), [a], { now: 1_000_000 + 10 * DAY });
    expect(res.alarms.some((x) => x.kind === 'back-dated')).toBe(true);
  });

  it('does not check when OTS is still pending (no upper bound yet)', () => {
    const a = att({ anchorTime: 1_000_000 }); // otsTime undefined
    const res = evaluate(definition(), [a], { now: 1_000_000 + 10 * DAY });
    expect(res.alarms.some((x) => x.kind === 'back-dated')).toBe(false);
  });

  it('respects a custom maxOtsStraddle', () => {
    const a = att({ anchorTime: 1_000_000, otsTime: 1_000_000 + 2 * 3600 }); // 2h straddle
    const res = evaluate(definition(), [a], { now: 1_000_000 + 10 * DAY, maxOtsStraddle: 3600 });
    expect(res.alarms.some((x) => x.kind === 'back-dated')).toBe(true); // 2h > 1h tolerance
  });
});

describe('diffDefinitions', () => {
  it('flags loosened cadence, widened freshness, dropped OTS, and removed clauses', () => {
    const prev = definition();
    const next = definition({
      cadence: 60 * DAY,
      freshness: { bitcoin: { maxBlockAge: 100 } },
      statements: [{ id: 'no-secret-order', text: 'a' }],
    });
    const drift = diffDefinitions(prev, next);
    const messages = drift.map((d) => d.message).join('\n');
    expect(drift.every((d) => d.kind === 'definition-drift')).toBe(true);
    expect(messages).toMatch(/cadence loosened/);
    expect(messages).toMatch(/freshness window widened/);
    expect(messages).toMatch(/OpenTimestamps requirement removed/);
    expect(messages).toMatch(/clause "no-backdoor" removed/);
  });

  it('says nothing when a definition is unchanged', () => {
    expect(diffDefinitions(definition(), definition())).toHaveLength(0);
  });
});
