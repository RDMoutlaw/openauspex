import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools';
import { KINDS } from '@openauspex/core';
import type { BitcoinProvider, NostrEvent, OtsVerification } from '@openauspex/core';

import { assess } from './assess.js';
import type { MonitorReport } from './assess.js';

export interface CanaryEvents {
  /** The newest definition seen (addressable events can have versions). */
  definition?: NostrEvent;
  attestations: NostrEvent[];
  otsEvents: NostrEvent[];
}

function collect(pool: SimplePool, relays: string[], filter: Filter, windowMs: number): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const byId = new Map<string, NostrEvent>();
    const sub = pool.subscribeMany(relays, filter, { onevent: (e) => byId.set(e.id, e) });
    setTimeout(() => {
      sub.close();
      resolve([...byId.values()]);
    }, windowMs);
  });
}

/**
 * Fetch a canary's raw events from relays: the latest definition, all attestations, and any OTS
 * proofs. Collects over a fixed window — more reliable than one-shot get/querySync in short-lived
 * processes, which close on the first EOSE (a freshly connected relay can EOSE before it flushes
 * stored events, returning nothing).
 */
export async function fetchCanaryEvents(
  pool: SimplePool,
  relays: string[],
  definitionPubkey: string,
  canaryId: string,
  windowMs = 6000,
): Promise<CanaryEvents> {
  const definitionAddr = `${KINDS.CANARY_DEFINITION}:${definitionPubkey}:${canaryId}`;

  const [definitions, attestations] = await Promise.all([
    collect(pool, relays, { kinds: [KINDS.CANARY_DEFINITION], authors: [definitionPubkey], '#d': [canaryId] }, windowMs),
    collect(pool, relays, { kinds: [KINDS.CANARY_ATTESTATION], '#a': [definitionAddr] }, windowMs),
  ]);

  const definition = definitions.sort((a, b) => b.created_at - a.created_at)[0];
  const otsEvents = attestations.length
    ? await collect(pool, relays, { kinds: [KINDS.OTS_ATTESTATION], '#e': attestations.map((a) => a.id) }, windowMs)
    : [];

  return { definition, attestations, otsEvents };
}

export interface MonitorOptions {
  relays: string[];
  definitionPubkey: string;
  canaryId: string;
  provider: BitcoinProvider;
  pool: SimplePool;
  verifyOts?: (proof: Uint8Array, eventId: string) => Promise<OtsVerification>;
  now?: () => number;
}

/** Watches a single canary on a set of relays and evaluates it. */
export class Monitor {
  constructor(private readonly opts: MonitorOptions) {}

  /** Fetch the definition + attestations + OTS proofs and evaluate. */
  async check(): Promise<MonitorReport> {
    const { pool, relays, definitionPubkey, canaryId } = this.opts;
    const { definition, attestations, otsEvents } = await fetchCanaryEvents(pool, relays, definitionPubkey, canaryId);
    if (!definition) {
      throw new Error(
        `definition not found on relays (pubkey ${definitionPubkey.slice(0, 12)}…, d="${canaryId}", relays: ${relays.join(', ')})`,
      );
    }
    return assess(definition, attestations, {
      provider: this.opts.provider,
      now: (this.opts.now ?? (() => Math.floor(Date.now() / 1000)))(),
      otsEvents,
      verifyOts: this.opts.verifyOts,
    });
  }

  /** Poll on an interval, invoking `onReport` each cycle. Returns a handle to stop. */
  watch(onReport: (report: MonitorReport) => void, opts: { intervalMs?: number } = {}): { stop: () => void } {
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        onReport(await this.check());
      } catch {
        // transient relay/provider error — retry next tick
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), opts.intervalMs ?? 60_000);
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}
