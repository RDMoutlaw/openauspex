/**
 * Browser-safe OpenTimestamps verification — recovers and **verifies** the not-later-than bound from
 * a NIP-03 proof without the Node `opentimestamps` library (which pulls in `request`/`fs`/`bitcore-lib`
 * and does not bundle for the browser).
 *
 * A canary *watcher* needs the timestamp of the Bitcoin block a proof commits into: it is the upper
 * bound that {@link evaluate} compares against the anchor (the lower bound) to detect back-dating.
 * This module parses the OTS serialization directly and replays its operations
 * (`append`/`prepend`/`sha256`/`ripemd160`) over the timestamped digest, exactly as a full verifier
 * would, to reconstruct the Merkle root the proof commits to.
 *
 * {@link verifyOtsBitcoin} then closes the loop: it confirms the proof commits the **expected event
 * id** (binding the proof to the attestation) and that the reconstructed Merkle root matches the real
 * block's `merkle_root` from a {@link BitcoinProvider} — ideally a {@link MultiProvider}, which
 * cross-checks the `merkle_root` across independent explorers so no single one can vouch for a forged
 * proof. Only then is the block time trusted. {@link extractBitcoinAttestation} exposes the same
 * reconstruction synchronously (no network) for display/inspection.
 *
 * Format reference: the OpenTimestamps serialization
 * (https://github.com/opentimestamps/python-opentimestamps) — a 31-byte detached-timestamp-file
 * header, then a timestamp tree of operations (each recursing into a sub-timestamp) and attestations.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';

import { getBlockByHeight, type BitcoinProvider } from './bitcoin/provider.js';

/** Thrown when proof bytes are malformed or use an unsupported operation. */
export class OtsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtsParseError';
  }
}

/** Thrown when a proof is well-formed but does not verify against the event id or the chain. */
export class OtsVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtsVerificationError';
  }
}

/** A Bitcoin attestation reconstructed from an OTS proof. */
export interface BitcoinAttestation {
  /** Height of the Bitcoin block the proof commits into. */
  height: number;
  /** The committed Merkle root, in block-explorer display order (big-endian hex). */
  merkleRoot: string;
}

/** A verified OTS upper bound: the proof provably commits the event id into this Bitcoin block. */
export interface OtsVerifyResult {
  /** Bitcoin block header time committing the event id (unix seconds) — the not-later-than bound. */
  time: number;
  height: number;
  merkleRoot: string;
}

// — OTS serialization constants ————————————————————————————————————————————————
// 31-byte magic prefixing a serialized DetachedTimestampFile.
const MAGIC = Uint8Array.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);

// 8-byte attestation type tag for a Bitcoin block-header attestation.
const BITCOIN_TAG = Uint8Array.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

const ATTESTATION = 0x00;
const FORK = 0xff;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
const OP_SHA256 = 0x08;
const OP_RIPEMD160 = 0x03;
// File-hash ops that may head the proof; the value is the digest byte-length to read for each.
const FILE_HASH_DIGEST_LEN: Record<number, number> = {
  0x02: 20, // sha1
  0x03: 20, // ripemd160
  0x08: 32, // sha256 (NIP-03: the digest is the 32-byte event id)
};

// — minimal byte reader ————————————————————————————————————————————————————————
class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readByte(): number {
    const byte = this.bytes[this.offset];
    if (byte === undefined) throw new OtsParseError('unexpected end of proof');
    this.offset++;
    return byte;
  }

  readBytes(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new OtsParseError('unexpected end of proof');
    return this.bytes.subarray(this.offset, (this.offset += n));
  }

  /** OpenTimestamps base-128 varuint (LSB-first groups, high bit = continue). */
  readVarUint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readByte();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new OtsParseError('varuint too large');
    } while (byte & 0x80);
    return result;
  }

  readVarBytes(): Uint8Array {
    return this.readBytes(this.readVarUint());
  }

  expect(prefix: Uint8Array, what: string): void {
    const got = this.readBytes(prefix.length);
    for (let i = 0; i < prefix.length; i++) {
      if (got[i] !== prefix[i]) throw new OtsParseError(`not an OpenTimestamps ${what}`);
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function reverseBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]!;
  return out;
}

/** Decode standard base64 to bytes without `Buffer`/`atob` (portable across Node and browsers). */
function base64ToBytes(b64: string): Uint8Array {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// — timestamp-tree walk ————————————————————————————————————————————————————————
interface RawAttestation {
  height: number;
  /** The message committed at the attestation (internal byte order). */
  root: Uint8Array;
}

// A timestamp is a run of branches; every branch except the last is prefixed with FORK (0xff). Each
// branch is an attestation, or an operation applied to `msg` that recurses into a sub-timestamp. All
// branches of a fork operate on the same `msg`.
function walk(reader: ByteReader, msg: Uint8Array, into: RawAttestation[]): void {
  let tag = reader.readByte();
  while (tag === FORK) {
    branch(reader, reader.readByte(), msg, into);
    tag = reader.readByte();
  }
  branch(reader, tag, msg, into);
}

function branch(reader: ByteReader, tag: number, msg: Uint8Array, into: RawAttestation[]): void {
  if (tag === ATTESTATION) {
    const attTag = reader.readBytes(8);
    const payload = reader.readVarBytes();
    if (bytesEqual(attTag, BITCOIN_TAG)) {
      into.push({ height: new ByteReader(payload).readVarUint(), root: msg });
    }
    // Pending (calendar) and unknown attestations carry no usable Bitcoin bound — ignore them.
    return;
  }
  let next: Uint8Array;
  if (tag === OP_APPEND) next = concatBytes(msg, reader.readVarBytes());
  else if (tag === OP_PREPEND) next = concatBytes(reader.readVarBytes(), msg);
  else if (tag === OP_SHA256) next = sha256(msg);
  else if (tag === OP_RIPEMD160) next = ripemd160(msg);
  else throw new OtsParseError(`unsupported OpenTimestamps operation 0x${tag.toString(16)}`);
  walk(reader, next, into);
}

/** Parse the header (returning the timestamped digest) and replay the tree to its attestations. */
function readProof(proof: Uint8Array | string): { digest: Uint8Array; attestations: RawAttestation[] } {
  const reader = new ByteReader(typeof proof === 'string' ? base64ToBytes(proof) : proof);
  reader.expect(MAGIC, 'detached timestamp file');
  reader.readVarUint(); // major version
  const fileHashOp = reader.readByte();
  const digestLen = FILE_HASH_DIGEST_LEN[fileHashOp];
  if (digestLen === undefined) {
    throw new OtsParseError(`unsupported file-hash operation 0x${fileHashOp.toString(16)}`);
  }
  const digest = reader.readBytes(digestLen).slice(); // the timestamped digest (the event id, NIP-03)
  const attestations: RawAttestation[] = [];
  walk(reader, digest, attestations);
  return { digest, attestations };
}

/** Of several Bitcoin attestations, the earliest block is the tightest (most conservative) bound. */
function tightest(attestations: RawAttestation[]): RawAttestation | null {
  if (attestations.length === 0) return null;
  return attestations.reduce((a, b) => (b.height < a.height ? b : a));
}

/**
 * Reconstruct the Bitcoin block an OTS proof commits into, or `null` if the proof is still pending
 * (calendar attestations only). Accepts raw proof bytes or the base64 `content` of a NIP-03 kind-1040
 * event. This replays the proof's operations but does **not** confirm the commitment against the chain
 * or bind it to an event id — use {@link verifyOtsBitcoin} for a trusted bound.
 *
 * @throws {OtsParseError} if the bytes are malformed or use an unsupported operation.
 */
export function extractBitcoinAttestation(proof: Uint8Array | string): BitcoinAttestation | null {
  const best = tightest(readProof(proof).attestations);
  if (!best) return null;
  return { height: best.height, merkleRoot: bytesToHex(reverseBytes(best.root)) };
}

/**
 * Verify that `proof` timestamps `eventId` into the Bitcoin chain and return the committing block's
 * time (the `otsTime` upper bound), or `null` if the proof is still pending.
 *
 * Replays the proof to reconstruct the committed Merkle root, then checks that (1) the proof's
 * timestamped digest equals `eventId` and (2) the reconstructed root matches the real block's
 * `merkle_root` from `provider`. Pass a {@link MultiProvider} so the `merkle_root` is cross-checked
 * across independent explorers. No `opentimestamps` dependency, no Bitcoin node — browser-safe.
 *
 * @throws {OtsParseError} on malformed proof bytes.
 * @throws {OtsVerificationError} if the proof does not commit `eventId`, the provider supplies no
 *   `merkle_root`, or the reconstructed root does not match the block.
 */
export async function verifyOtsBitcoin(
  proof: Uint8Array | string,
  eventId: string,
  provider: BitcoinProvider,
): Promise<OtsVerifyResult | null> {
  const { digest, attestations } = readProof(proof);

  if (bytesToHex(digest) !== eventId.toLowerCase()) {
    throw new OtsVerificationError('OTS proof does not commit the given event id');
  }

  const best = tightest(attestations);
  if (!best) return null; // pending: no Bitcoin attestation yet

  const committedRoot = bytesToHex(reverseBytes(best.root));
  const block = await getBlockByHeight(provider, best.height);
  if (block.merkleRoot === undefined) {
    throw new OtsVerificationError(`provider supplied no merkle root for block ${best.height}`);
  }
  if (block.merkleRoot.toLowerCase() !== committedRoot) {
    throw new OtsVerificationError(
      `OTS proof does not commit block ${best.height}: merkle root mismatch`,
    );
  }
  return { time: block.timestamp, height: best.height, merkleRoot: committedRoot };
}

/**
 * Convenience wrapper over {@link verifyOtsBitcoin} returning just the verified block time (the
 * `otsTime` upper bound for {@link EvaluatedAttestation}), or `undefined` for a still-pending proof.
 * Throws (via {@link verifyOtsBitcoin}) if the proof fails to verify.
 */
export async function otsTimeFromProof(
  proof: Uint8Array | string,
  eventId: string,
  provider: BitcoinProvider,
): Promise<number | undefined> {
  return (await verifyOtsBitcoin(proof, eventId, provider))?.time;
}
