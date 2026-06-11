import { describe, expect, it } from 'vitest';

import { MempoolProvider } from '../src/bitcoin/mempool';
import { MultiProvider } from '../src/bitcoin/multi';
import type { BitcoinProvider, BlockInfo } from '../src/bitcoin/provider';
import type { FetchLike, HttpResponse } from '../src/bitcoin/http';

/** A fake fetch that serves canned responses keyed by full URL. */
function fakeFetch(routes: Record<string, string | object>): FetchLike {
  return async (url: string): Promise<HttpResponse> => {
    if (!(url in routes)) {
      return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
    }
    const body = routes[url];
    return {
      ok: true,
      status: 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
  };
}

/** In-memory provider over a fixed set of blocks. */
class MockProvider implements BitcoinProvider {
  constructor(
    private readonly blocks: Map<number, BlockInfo>,
    private readonly tip: number,
  ) {}
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
    return this.tip;
  }
}

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const base = 'https://x/api';

describe('MempoolProvider', () => {
  it('parses block-height, block, and tip responses', async () => {
    const provider = new MempoolProvider({
      baseUrl: base,
      fetchFn: fakeFetch({
        [`${base}/block-height/800000`]: H,
        [`${base}/block/${H}`]: { id: H, height: 800000, timestamp: 1690000000 },
        [`${base}/blocks/tip/height`]: '850000',
      }),
    });
    expect(await provider.getBlockHashByHeight(800000)).toBe(H);
    expect(await provider.getBlock(H)).toEqual({ height: 800000, hash: H, timestamp: 1690000000 });
    expect(await provider.getTipHeight()).toBe(850000);
  });

  it('rejects a malformed block-hash response', async () => {
    const provider = new MempoolProvider({
      baseUrl: base,
      fetchFn: fakeFetch({ [`${base}/block-height/1`]: 'not-a-hash' }),
    });
    await expect(provider.getBlockHashByHeight(1)).rejects.toThrow(/unexpected block hash/);
  });
});

describe('MultiProvider', () => {
  const block = (height: number, hash: string, timestamp: number): Map<number, BlockInfo> =>
    new Map([[height, { height, hash, timestamp }]]);

  it('returns a value the quorum agrees on', async () => {
    const a = new MockProvider(block(800000, H, 1690000000), 850000);
    const b = new MockProvider(block(800000, H, 1690000000), 850001);
    const multi = new MultiProvider([a, b]);
    expect(await multi.getBlockHashByHeight(800000)).toBe(H);
  });

  it('follows the majority when one provider disagrees', async () => {
    const honest1 = new MockProvider(block(800000, H, 1690000000), 850000);
    const honest2 = new MockProvider(block(800000, H, 1690000000), 850000);
    const liar = new MockProvider(block(800000, H2, 1690000000), 850000);
    const multi = new MultiProvider([honest1, liar, honest2]); // quorum = 2
    expect(await multi.getBlockHashByHeight(800000)).toBe(H);
  });

  it('throws when no value reaches the quorum', async () => {
    const a = new MockProvider(block(800000, H, 1690000000), 850000);
    const b = new MockProvider(block(800000, H2, 1690000000), 850000);
    const multi = new MultiProvider([a, b]); // quorum = 2, but 1 vs 1
    await expect(multi.getBlockHashByHeight(800000)).rejects.toThrow(/disagree/);
  });

  it('takes the maximum reported tip height', async () => {
    const a = new MockProvider(new Map(), 850000);
    const b = new MockProvider(new Map(), 850001);
    expect(await new MultiProvider([a, b], { quorum: 1 }).getTipHeight()).toBe(850001);
  });
});
