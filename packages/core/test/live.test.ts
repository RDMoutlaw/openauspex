import { describe, expect, it } from 'vitest';

import { MempoolProvider } from '../src/bitcoin/mempool';
import { getBlockByHeight } from '../src/bitcoin/provider';

// Opt-in: hits the real mempool.space API. Enable with LIVE_BITCOIN_TESTS=1 so CI stays offline.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const LIVE = Boolean(env?.LIVE_BITCOIN_TESTS);

describe.skipIf(!LIVE)('live mempool.space', () => {
  it('round-trips a historical block by height', async () => {
    const provider = new MempoolProvider();
    const block = await getBlockByHeight(provider, 800000);
    expect(block.height).toBe(800000);
    expect(block.hash).toMatch(/^[0-9a-f]{64}$/);
    // Block 800,000 was mined in July 2023.
    expect(block.timestamp).toBeGreaterThan(1688000000);
    expect(block.timestamp).toBeLessThan(1691000000);
  });

  it('reports a plausible tip height', async () => {
    const tip = await new MempoolProvider().getTipHeight();
    expect(tip).toBeGreaterThan(800000);
  });
});
