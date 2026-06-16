import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import {
  extractBitcoinAttestation,
  verifyOtsBitcoin,
  otsTimeFromProof,
  OtsParseError,
  OtsVerificationError,
} from '../src/ots-block';
import type { BitcoinProvider, BlockInfo } from '../src/bitcoin/provider';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// Ground truth for complete.txt.ots, cross-checked against mainnet block 358391.
const COMPLETE = {
  digest: '03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340',
  height: 358391,
  merkleRoot: '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00',
  time: 1432827678,
};
// incomplete.txt.ots is calendar-pending only; this is the digest it timestamps.
const INCOMPLETE_DIGEST = '05c4f616a8e5310d19d938cfd769864d7f4ccdc2ca8b479b10af83564b097af9';

/** A provider serving exactly one block (the hash value is irrelevant to OTS verification). */
function providerFor(block: BlockInfo): BitcoinProvider {
  return {
    async getBlockHashByHeight(height) {
      if (height !== block.height) throw new Error(`no block at height ${height}`);
      return block.hash;
    },
    async getBlock(hash) {
      if (hash !== block.hash) throw new Error(`no block ${hash}`);
      return block;
    },
    async getTipHeight() {
      return block.height;
    },
  };
}

const block358391: BlockInfo = {
  height: COMPLETE.height,
  hash: 'b'.repeat(64),
  timestamp: COMPLETE.time,
  merkleRoot: COMPLETE.merkleRoot,
};

describe('extractBitcoinAttestation', () => {
  it('reconstructs the committed block and merkle root from a complete proof', () => {
    expect(extractBitcoinAttestation(fixture('complete.txt.ots'))).toEqual({
      height: COMPLETE.height,
      merkleRoot: COMPLETE.merkleRoot,
    });
  });

  it('accepts a base64 string (a NIP-03 event’s content)', () => {
    const b64 = Buffer.from(fixture('complete.txt.ots')).toString('base64');
    expect(extractBitcoinAttestation(b64)?.height).toBe(COMPLETE.height);
  });

  it('returns null for a pending (calendar-only) proof', () => {
    expect(extractBitcoinAttestation(fixture('incomplete.txt.ots'))).toBeNull();
  });

  it('throws OtsParseError on non-OTS bytes', () => {
    expect(() => extractBitcoinAttestation(Uint8Array.from([1, 2, 3]))).toThrow(OtsParseError);
  });
});

describe('verifyOtsBitcoin', () => {
  it('verifies a proof against its event id and the chain', async () => {
    const result = await verifyOtsBitcoin(
      fixture('complete.txt.ots'),
      COMPLETE.digest,
      providerFor(block358391),
    );
    expect(result).toEqual({
      time: COMPLETE.time,
      height: COMPLETE.height,
      merkleRoot: COMPLETE.merkleRoot,
    });
  });

  it('exposes the verified time via otsTimeFromProof', async () => {
    const time = await otsTimeFromProof(
      fixture('complete.txt.ots'),
      COMPLETE.digest,
      providerFor(block358391),
    );
    expect(time).toBe(COMPLETE.time);
  });

  it('rejects a proof that does not commit the given event id', async () => {
    await expect(
      verifyOtsBitcoin(fixture('complete.txt.ots'), 'a'.repeat(64), providerFor(block358391)),
    ).rejects.toThrow(OtsVerificationError);
  });

  it('rejects when the block merkle root does not match the proof', async () => {
    const tampered: BlockInfo = { ...block358391, merkleRoot: 'f'.repeat(64) };
    await expect(
      verifyOtsBitcoin(fixture('complete.txt.ots'), COMPLETE.digest, providerFor(tampered)),
    ).rejects.toThrow(OtsVerificationError);
  });

  it('rejects when the provider supplies no merkle root', async () => {
    const noRoot: BlockInfo = { ...block358391, merkleRoot: undefined };
    await expect(
      verifyOtsBitcoin(fixture('complete.txt.ots'), COMPLETE.digest, providerFor(noRoot)),
    ).rejects.toThrow(OtsVerificationError);
  });

  it('returns null for a pending proof once its event id checks out', async () => {
    const result = await verifyOtsBitcoin(
      fixture('incomplete.txt.ots'),
      INCOMPLETE_DIGEST,
      providerFor(block358391),
    );
    expect(result).toBeNull();
  });
});
