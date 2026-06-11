import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDefinition, validateAttestation, validateDefinition } from '@openauspex/core';
import type { BitcoinProvider, BlockInfo, NostrEvent } from '@openauspex/core';

import { assess } from '../src/assess';

interface Vectors {
  now: number;
  expected: { state: string; threshold: number; freshSigners: number };
  blocks: BlockInfo[];
  definition: NostrEvent;
  attestations: NostrEvent[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../test-vectors/vectors.json', import.meta.url), 'utf8'),
) as Vectors;

/** Offline provider serving exactly the blocks embedded in the vectors. */
class VectorProvider implements BitcoinProvider {
  private readonly byHeight = new Map<number, BlockInfo>();
  private readonly byHash = new Map<string, BlockInfo>();
  constructor(blocks: BlockInfo[]) {
    for (const b of blocks) {
      this.byHeight.set(b.height, b);
      this.byHash.set(b.hash, b);
    }
  }
  async getBlockHashByHeight(height: number): Promise<string> {
    const b = this.byHeight.get(height);
    if (!b) throw new Error(`no block at ${height}`);
    return b.hash;
  }
  async getBlock(hash: string): Promise<BlockInfo> {
    const b = this.byHash.get(hash);
    if (!b) throw new Error(`no block ${hash}`);
    return b;
  }
  async getTipHeight(): Promise<number> {
    return Math.max(...this.byHeight.keys());
  }
}

describe('reference vectors', () => {
  const provider = new VectorProvider(vectors.blocks);

  it('the definition validates', () => {
    expect(validateDefinition(vectors.definition).valid).toBe(true);
  });

  it('every attestation validates against the definition', () => {
    const definition = parseDefinition(vectors.definition);
    for (const att of vectors.attestations) {
      expect(validateAttestation(att, { definition }).valid).toBe(true);
    }
  });

  it('the chain evaluates to the expected state with authentic anchors', async () => {
    const report = await assess(vectors.definition, vectors.attestations, {
      provider,
      now: vectors.now,
    });
    expect(report.evaluation.state).toBe(vectors.expected.state);
    expect(report.evaluation.freshSigners).toHaveLength(vectors.expected.freshSigners);
    expect(report.issues).toHaveLength(0);
  });
});
