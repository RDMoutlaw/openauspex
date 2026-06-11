import type { BitcoinProvider, BlockInfo } from './bitcoin/provider.js';
import { getBlockByHeight } from './bitcoin/provider.js';
import type { BlockAnchor } from './types.js';

/** Nominal Bitcoin block interval (seconds), used to convert a block-count window to a duration. */
export const SECONDS_PER_BLOCK = 600;

export interface AnchorVerification {
  /** The embedded hash matches the canonical hash at the anchor height. */
  authentic: boolean;
  /** Authoritative block info (present once the height resolves), carrying the trusted timestamp. */
  block?: BlockInfo;
  reason?: string;
}

/**
 * Verify that an attestation's block anchor really is the mainnet block at that height — the
 * "hash_H is the real mainnet hash at height H" check. Pass a {@link MultiProvider} to avoid
 * trusting a single explorer.
 */
export async function verifyAnchor(
  anchor: BlockAnchor,
  provider: BitcoinProvider,
): Promise<AnchorVerification> {
  let block: BlockInfo;
  try {
    block = await getBlockByHeight(provider, anchor.height);
  } catch (e) {
    return {
      authentic: false,
      reason: `could not resolve block at height ${anchor.height}: ${(e as Error).message}`,
    };
  }
  if (block.hash !== anchor.hash) {
    return { authentic: false, block, reason: `hash mismatch: anchor ${anchor.hash} ≠ chain ${block.hash}` };
  }
  return { authentic: true, block };
}

/** Convert a freshness window expressed in blocks to seconds. */
export function blockWindowToSeconds(maxBlockAge: number, secondsPerBlock = SECONDS_PER_BLOCK): number {
  return maxBlockAge * secondsPerBlock;
}

export interface BlockRecency {
  fresh: boolean;
  ageBlocks: number;
}

/**
 * Block-height view of recency: is the anchor within `maxBlockAge` blocks of the tip? Applies to
 * the *latest* attestation — a stalled canary's newest anchor falls further behind the tip.
 */
export function checkBlockRecency(
  anchorHeight: number,
  tipHeight: number,
  maxBlockAge: number,
): BlockRecency {
  const ageBlocks = tipHeight - anchorHeight;
  return { fresh: ageBlocks <= maxBlockAge, ageBlocks };
}

export interface RecencyCheck {
  fresh: boolean;
  ageSeconds: number;
  maxAgeSeconds: number;
}

/**
 * Time view of recency using the anchor block's *trusted* header timestamp (never `created_at`):
 * is the block older than the freshness window relative to `referenceTime`? `referenceTime` is
 * chosen by the caller — the monitor's current time for liveness, or an OTS upper bound.
 */
export function checkRecency(
  block: BlockInfo,
  referenceTime: number,
  maxBlockAge: number,
  secondsPerBlock = SECONDS_PER_BLOCK,
): RecencyCheck {
  const ageSeconds = referenceTime - block.timestamp;
  const maxAgeSeconds = blockWindowToSeconds(maxBlockAge, secondsPerBlock);
  return { fresh: ageSeconds <= maxAgeSeconds, ageSeconds, maxAgeSeconds };
}
