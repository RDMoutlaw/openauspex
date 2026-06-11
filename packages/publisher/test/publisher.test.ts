import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';

import { Publisher } from '../src/publisher';
import { MemoryStore } from '../src/store';
import { simplePoolPublisher } from '../src/publish';
import type { PublishFn, PublishResult } from '../src/publish';
import type { SimplePool } from 'nostr-tools/pool';
import type { BitcoinProvider, BlockInfo } from '@openauspex/core';

const BLOCK: BlockInfo = { height: 850000, hash: 'a'.repeat(64), timestamp: 1700000000 };

class FixedProvider implements BitcoinProvider {
  async getBlockHashByHeight(): Promise<string> {
    return BLOCK.hash;
  }
  async getBlock(): Promise<BlockInfo> {
    return BLOCK;
  }
  async getTipHeight(): Promise<number> {
    return BLOCK.height;
  }
}

function recordingPublish() {
  const calls: { relays: string[]; kind: number; id: string }[] = [];
  const fn: PublishFn = async (relays, event) => {
    calls.push({ relays, kind: event.kind, id: event.id });
    return relays.map<PublishResult>((r) => ({ relay: r, ok: true }));
  };
  return { fn, calls };
}

describe('Publisher', () => {
  it('attest anchors a recent block, publishes, and stores a pending stamp', async () => {
    const store = new MemoryStore();
    const pub = recordingPublish();
    const publisher = new Publisher({
      secretKey: generateSecretKey(),
      relays: ['wss://r1'],
      provider: new FixedProvider(),
      publish: pub.fn,
      store,
      ots: { stamp: async () => Uint8Array.from([1, 2, 3]) },
      now: () => 1700000050,
    });

    const res = await publisher.attest({ canaryId: 'primary', affirms: ['no-secret-order'] });
    expect(res.anchor).toEqual({ height: 850000, hash: 'a'.repeat(64) });
    expect(res.event.kind).toBe(1772);
    expect(res.stamped).toBe(true);
    expect(pub.calls).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.eventId).toBe(res.event.id);
  });

  it('upgradePending publishes a kind-1040 once the proof is complete', async () => {
    const store = new MemoryStore();
    const pub = recordingPublish();
    const publisher = new Publisher({
      secretKey: generateSecretKey(),
      relays: ['wss://r1'],
      provider: new FixedProvider(),
      publish: pub.fn,
      store,
      ots: {
        stamp: async () => Uint8Array.from([1, 2, 3]),
        upgrade: async (proof) => ({ upgraded: true, proof }),
        isComplete: () => true,
      },
      now: () => 1700000050,
    });

    await publisher.attest({ canaryId: 'primary', affirms: ['x'] });
    const report = await publisher.upgradePending();

    expect(report[0]?.published).toBe(true);
    expect(pub.calls.map((c) => c.kind)).toEqual([1772, 1040]); // attestation, then OTS proof
    expect(store.list()[0]!.resolvedAt).toBeDefined();
  });

  it('upgradePending defers when the proof is not yet complete', async () => {
    const store = new MemoryStore();
    const pub = recordingPublish();
    const publisher = new Publisher({
      secretKey: generateSecretKey(),
      relays: ['wss://r1'],
      provider: new FixedProvider(),
      publish: pub.fn,
      store,
      ots: {
        stamp: async () => Uint8Array.from([1, 2, 3]),
        upgrade: async (proof) => ({ upgraded: false, proof }),
        isComplete: () => false,
      },
      now: () => 1700000050,
    });

    await publisher.attest({ canaryId: 'primary', affirms: ['x'] });
    const report = await publisher.upgradePending();

    expect(report[0]).toMatchObject({ complete: false, published: false });
    expect(pub.calls.map((c) => c.kind)).toEqual([1772]); // no 1040 yet
    expect(store.list()[0]!.resolvedAt).toBeUndefined();
  });
});

describe('simplePoolPublisher', () => {
  it('reports nostr-tools connection-failure resolutions as not-ok', async () => {
    // nostr-tools resolves (not rejects) on connection failure with a marker string.
    const fakePool = {
      publish: () => [Promise.resolve(''), Promise.resolve('connection failure: boom')],
    } as unknown as SimplePool;

    const results = await simplePoolPublisher(fakePool)(['wss://ok', 'wss://bad'], { id: 'x' } as never);
    expect(results[0]).toMatchObject({ relay: 'wss://ok', ok: true });
    expect(results[1]).toMatchObject({ relay: 'wss://bad', ok: false });
  });
});
