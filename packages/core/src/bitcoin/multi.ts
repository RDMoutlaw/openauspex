import type { BitcoinProvider, BlockInfo } from './provider.js';

export interface MultiProviderOptions {
  /**
   * Minimum number of providers that must agree on a value. Defaults to a simple majority
   * (`floor(n/2) + 1`). Raising it strengthens the trust model at the cost of availability.
   */
  quorum?: number;
}

/**
 * Cross-checks several independent {@link BitcoinProvider}s. A value is only returned when at
 * least `quorum` providers agree on it — defeating a single lying or compromised explorer, which
 * is exactly the trust weakness a website-grade canary suffers from. Providers that error out are
 * simply ignored (as long as the quorum is still met among those that responded).
 */
export class MultiProvider implements BitcoinProvider {
  private readonly providers: BitcoinProvider[];
  private readonly quorum: number;

  constructor(providers: BitcoinProvider[], opts: MultiProviderOptions = {}) {
    if (providers.length === 0) throw new Error('MultiProvider needs at least one provider');
    this.providers = providers;
    this.quorum = opts.quorum ?? Math.floor(providers.length / 2) + 1;
  }

  async getBlockHashByHeight(height: number): Promise<string> {
    const results = await this.collect((p) => p.getBlockHashByHeight(height));
    return this.agree(results, (h) => h, `block hash at height ${height}`);
  }

  async getBlock(hash: string): Promise<BlockInfo> {
    const results = await this.collect((p) => p.getBlock(hash));
    // Include merkleRoot so a single explorer cannot slip a forged root past the quorum — OTS
    // verification (`verifyOtsBitcoin`) trusts the agreed-upon root.
    return this.agree(
      results,
      (b) => `${b.height}:${b.timestamp}:${b.hash}:${b.merkleRoot ?? ''}`,
      `block ${hash}`,
    );
  }

  async getTipHeight(): Promise<number> {
    const results = await this.collect((p) => p.getTipHeight());
    if (results.length === 0) throw new Error('no provider returned a tip height');
    // The tip legitimately varies by propagation; take the max so anchor age is never
    // *underestimated* (which would be the unsafe direction — making stale anchors look fresh).
    return Math.max(...results);
  }

  private async collect<T>(fn: (p: BitcoinProvider) => Promise<T>): Promise<T[]> {
    const settled = await Promise.allSettled(this.providers.map(fn));
    return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  }

  private agree<T>(results: T[], key: (v: T) => string, what: string): T {
    const tally = new Map<string, { value: T; n: number }>();
    for (const r of results) {
      const k = key(r);
      const entry = tally.get(k);
      if (entry) entry.n += 1;
      else tally.set(k, { value: r, n: 1 });
    }
    let best: { value: T; n: number } | undefined;
    for (const entry of tally.values()) {
      if (!best || entry.n > best.n) best = entry;
    }
    if (!best || best.n < this.quorum) {
      throw new Error(
        `providers disagree on ${what}: best ${best?.n ?? 0}/${this.providers.length} agree, need ${this.quorum}`,
      );
    }
    return best.value;
  }
}
