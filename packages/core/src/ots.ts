import { Buffer } from 'node:buffer';
import OpenTimestamps from 'opentimestamps';
import type { EventTemplate } from 'nostr-tools';

import { KINDS, TAG } from './kinds.js';
import { CanaryParseError } from './errors.js';
import { firstTag, nowSeconds } from './tags.js';
import type { NostrEvent } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64Decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function detachedForEventId(eventId: string) {
  if (!HEX64.test(eventId)) throw new Error(`invalid event id: "${eventId}"`);
  // A Nostr event id is itself a SHA-256 digest, so we timestamp it directly (per NIP-03).
  return OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(),
    Buffer.from(eventId, 'hex'),
  );
}

/** Stamp a Nostr event id via OpenTimestamps calendars, returning the (initially pending) proof bytes. */
export async function stampEventId(eventId: string): Promise<Uint8Array> {
  const detached = detachedForEventId(eventId);
  await OpenTimestamps.stamp(detached);
  return new Uint8Array(detached.serializeToBytes());
}

/** Attempt to upgrade a pending proof to a complete Bitcoin attestation. */
export async function upgradeProof(
  proof: Uint8Array,
): Promise<{ upgraded: boolean; proof: Uint8Array }> {
  const detached = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(proof));
  const upgraded = await OpenTimestamps.upgrade(detached);
  return { upgraded, proof: new Uint8Array(detached.serializeToBytes()) };
}

export interface OtsVerification {
  /** A Bitcoin attestation is present and verified — the proof is complete. */
  complete: boolean;
  /** Bitcoin block time (unix seconds) committing the event id, when complete. */
  bitcoinTime?: number;
  /** Bitcoin block height, when reported. */
  height?: number;
}

/**
 * Verify that `proof` timestamps `eventId` into the Bitcoin chain. Uses block-explorer
 * verification by default (`ignoreBitcoinNode`), so no local Bitcoin node is required.
 */
export async function verifyProof(
  proof: Uint8Array,
  eventId: string,
  opts: { ignoreBitcoinNode?: boolean } = {},
): Promise<OtsVerification> {
  const detachedOts = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(proof));
  const original = detachedForEventId(eventId);
  const result: unknown = await OpenTimestamps.verify(detachedOts, original, {
    ignoreBitcoinNode: opts.ignoreBitcoinNode ?? true,
  });

  // Tolerate both known return shapes: a bare unix-time number, or `{ bitcoin: { timestamp, height } }`.
  if (typeof result === 'number') return { complete: true, bitcoinTime: result };
  if (result && typeof result === 'object') {
    const bitcoin = (result as Record<string, unknown>)['bitcoin'];
    if (bitcoin && typeof bitcoin === 'object') {
      const ts = (bitcoin as Record<string, unknown>)['timestamp'];
      const height = (bitcoin as Record<string, unknown>)['height'];
      if (typeof ts === 'number') {
        return { complete: true, bitcoinTime: ts, height: typeof height === 'number' ? height : undefined };
      }
    }
  }
  return { complete: false };
}

/**
 * Whether a proof is **self-contained**: it carries a complete Bitcoin attestation and therefore
 * verifies against the chain alone, without the OpenTimestamps calendars needing to stay online. A
 * pending proof (only calendar attestations) is not yet complete. Synchronous — inspects the bytes
 * only, no network.
 */
export function isOtsComplete(proof: Uint8Array): boolean {
  const detached = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(proof));
  for (const attestation of detached.timestamp.allAttestations().values()) {
    if (attestation instanceof OpenTimestamps.Notary.BitcoinBlockHeaderAttestation) return true;
  }
  return false;
}

/** Human-readable proof structure: the Merkle path from the digest up to its attestation(s). */
export function otsInfo(proof: Uint8Array): string {
  return OpenTimestamps.info(OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(proof)));
}

export interface BuildOtsAttestationParams {
  /** The Nostr event id being timestamped. */
  eventId: string;
  /** Kind of the timestamped event (for the `k` tag). */
  eventKind: number;
  /** Complete OTS proof bytes (should contain a Bitcoin attestation, not a pending one). */
  proof: Uint8Array;
  relay?: string;
  created_at?: number;
}

/** Build an unsigned NIP-03 kind-1040 OpenTimestamps attestation event. */
export function buildOtsAttestation(params: BuildOtsAttestationParams): EventTemplate {
  const eTag = params.relay ? [TAG.E, params.eventId, params.relay] : [TAG.E, params.eventId];
  return {
    kind: KINDS.OTS_ATTESTATION,
    created_at: params.created_at ?? nowSeconds(),
    content: base64Encode(params.proof),
    tags: [eTag, [TAG.K, String(params.eventKind)]],
  };
}

export interface ParsedOtsAttestation {
  /** The timestamped event's id (from the `e` tag). */
  targetId: string;
  /** The timestamped event's kind (from the `k` tag), if present. */
  targetKind?: number;
  relay?: string;
  proof: Uint8Array;
}

/** Parse a NIP-03 kind-1040 event into its target reference and proof bytes. */
export function parseOtsAttestation(event: NostrEvent): ParsedOtsAttestation {
  if (event.kind !== KINDS.OTS_ATTESTATION) {
    throw new CanaryParseError(`expected kind ${KINDS.OTS_ATTESTATION}, got ${event.kind}`);
  }
  const eTag = firstTag(event.tags, TAG.E);
  const targetId = eTag?.[1];
  if (targetId === undefined) throw new CanaryParseError('OTS attestation is missing an `e` tag');

  const kRaw = firstTag(event.tags, TAG.K)?.[1];
  const kNum = kRaw === undefined ? NaN : Number(kRaw);

  return {
    targetId,
    targetKind: Number.isInteger(kNum) ? kNum : undefined,
    relay: eTag?.[2],
    proof: base64Decode(event.content),
  };
}
