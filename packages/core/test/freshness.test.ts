import { describe, expect, it } from 'vitest';

import { checkBlockRecency, checkRecency, verifyAnchor } from '../src/freshness';
import type { BitcoinProvider, BlockInfo } from '../src/bitcoin/provider';

class MockProvider implements BitcoinProvider {
  constructor(private readonly blocks: Map<number, BlockInfo>) {}
  async getBlockHashByHeight(height: number): Promise<string> {
    const b = this.blocks.get(height);
    if (!b) throw new Error(`no block at ${height}`);
    return b.hash;
  }
  async getBlock(hash: string): Promise<BlockInfo> {
    for (const b of this.blocks.values()) if (b.hash === hash) return b;
    throw new Error(`no block ${hash}`);
  }
  async getTipHeight(): Promise<number> {
    return Math.max(0, ...this.blocks.keys());
  }
}

const H = 'a'.repeat(64);
const provider = new MockProvider(new Map([[800000, { height: 800000, hash: H, timestamp: 1690000000 }]]));

describe('verifyAnchor', () => {
  it('accepts an anchor whose hash matches the chain', async () => {
    const res = await verifyAnchor({ height: 800000, hash: H }, provider);
    expect(res.authentic).toBe(true);
    expect(res.block?.timestamp).toBe(1690000000);
  });

  it('rejects an anchor whose hash does not match', async () => {
    const res = await verifyAnchor({ height: 800000, hash: 'b'.repeat(64) }, provider);
    expect(res.authentic).toBe(false);
    expect(res.reason).toMatch(/hash mismatch/);
  });

  it('rejects an anchor whose height does not resolve', async () => {
    const res = await verifyAnchor({ height: 999999, hash: H }, provider);
    expect(res.authentic).toBe(false);
    expect(res.reason).toMatch(/could not resolve/);
  });
});

describe('recency math', () => {
  it('measures block recency against the tip', () => {
    expect(checkBlockRecency(96, 100, 6)).toEqual({ fresh: true, ageBlocks: 4 });
    expect(checkBlockRecency(90, 100, 6)).toEqual({ fresh: false, ageBlocks: 10 });
  });

  it('measures time recency against a reference time using the block timestamp', () => {
    const block: BlockInfo = { height: 1, hash: H, timestamp: 1000 };
    expect(checkRecency(block, 1000 + 3000, 6)).toMatchObject({ fresh: true, ageSeconds: 3000 });
    expect(checkRecency(block, 1000 + 4000, 6)).toMatchObject({ fresh: false, ageSeconds: 4000 });
  });
});
