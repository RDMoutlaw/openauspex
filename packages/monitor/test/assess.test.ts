import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildAttestation, buildDefinition } from '@openauspex/core';
import type { BitcoinProvider, BlockInfo, NostrEvent } from '@openauspex/core';

import { assess } from '../src/assess';

const BASE_TS = 1_700_000_000;
const hashFor = (height: number): string => height.toString(16).padStart(64, '0');

/** Deterministic chain: hash encodes the height, timestamp grows ~10 min per block from 850000. */
class ChainProvider implements BitcoinProvider {
  async getBlockHashByHeight(height: number): Promise<string> {
    return hashFor(height);
  }
  async getBlock(hash: string): Promise<BlockInfo> {
    const height = parseInt(hash, 16);
    return { height, hash, timestamp: BASE_TS + (height - 850000) * 600 };
  }
  async getTipHeight(): Promise<number> {
    return 850000;
  }
}

function makeDefinition() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const defEvent = finalizeEvent(
    buildDefinition({
      id: 'primary',
      content: 'c',
      cadence: 30 * 86400,
      grace: 7 * 86400,
      freshness: { bitcoin: { maxBlockAge: 6 } },
      statements: [
        { id: 'no-secret-order', text: 'a' },
        { id: 'no-backdoor', text: 'b' },
      ],
    }),
    sk,
  );
  return { sk, pk, defEvent };
}

function attestation(sk: Uint8Array, pk: string, affirms: string[], height: number, hash = hashFor(height)): NostrEvent {
  return finalizeEvent(
    buildAttestation({ definitionPubkey: pk, canaryId: 'primary', affirms, anchor: { height, hash }, created_at: BASE_TS }),
    sk,
  );
}

describe('assess', () => {
  it('reports alive for a fresh, authentic attestation', async () => {
    const { sk, pk, defEvent } = makeDefinition();
    const att = attestation(sk, pk, ['no-secret-order', 'no-backdoor'], 850000);
    const report = await assess(defEvent, [att], { provider: new ChainProvider(), now: BASE_TS + 10 * 86400 });
    expect(report.evaluation.state).toBe('alive');
    expect(report.issues).toHaveLength(0);
  });

  it('reports dead past cadence + grace', async () => {
    const { sk, pk, defEvent } = makeDefinition();
    const att = attestation(sk, pk, ['no-secret-order'], 850000);
    const report = await assess(defEvent, [att], { provider: new ChainProvider(), now: BASE_TS + 40 * 86400 });
    expect(report.evaluation.state).toBe('dead');
  });

  it('marks an attestation with an unauthentic anchor invalid', async () => {
    const { sk, pk, defEvent } = makeDefinition();
    const att = attestation(sk, pk, ['no-secret-order'], 850000, 'f'.repeat(64));
    const report = await assess(defEvent, [att], { provider: new ChainProvider(), now: BASE_TS + 10 * 86400 });
    expect(report.evaluation.state).toBe('unknown'); // the only attestation does not count
    expect(report.issues[0]?.issues.some((i) => i.code === 'anchor-unauthentic')).toBe(true);
  });

  it('raises a clause-drop alarm across two attestations', async () => {
    const { sk, pk, defEvent } = makeDefinition();
    const a1 = attestation(sk, pk, ['no-secret-order', 'no-backdoor'], 850000);
    const a2 = attestation(sk, pk, ['no-secret-order'], 850100);
    const report = await assess(defEvent, [a1, a2], { provider: new ChainProvider(), now: BASE_TS + 31 * 86400 });
    expect(report.evaluation.alarms.some((x) => x.kind === 'clause-drop' && x.clause === 'no-backdoor')).toBe(true);
  });
});
