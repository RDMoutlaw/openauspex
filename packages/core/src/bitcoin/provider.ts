/** Minimal view of a Bitcoin block needed for freshness anchoring. */
export interface BlockInfo {
  height: number;
  hash: string;
  /** Block header timestamp, unix seconds. The trusted clock for canary timing. */
  timestamp: number;
  /**
   * Block header Merkle root, big-endian display hex. Optional — populated by Esplora providers and
   * required only for OpenTimestamps verification (`verifyOtsBitcoin`); freshness/anchoring do not
   * use it.
   */
  merkleRoot?: string;
}

/**
 * A source of canonical (best-chain) Bitcoin block data. Implemented by {@link MempoolProvider}
 * against an Esplora-compatible API, and composed by {@link MultiProvider} for cross-checking.
 */
export interface BitcoinProvider {
  /** Hash of the best-chain block at `height`. */
  getBlockHashByHeight(height: number): Promise<string>;
  /** Full info for a block identified by `hash`. */
  getBlock(hash: string): Promise<BlockInfo>;
  /** Current best-chain tip height. */
  getTipHeight(): Promise<number>;
}

/** Resolve a block directly by height (hash lookup, then block fetch). */
export async function getBlockByHeight(
  provider: BitcoinProvider,
  height: number,
): Promise<BlockInfo> {
  const hash = await provider.getBlockHashByHeight(height);
  return provider.getBlock(hash);
}
