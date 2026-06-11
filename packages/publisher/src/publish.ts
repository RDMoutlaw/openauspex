import type { NostrEvent } from '@openauspex/core';
import type { SimplePool } from 'nostr-tools/pool';

export interface PublishResult {
  relay: string;
  ok: boolean;
  error?: string;
}

/** Publish a signed event to several relays, reporting per-relay success. */
export type PublishFn = (relays: string[], event: NostrEvent) => Promise<PublishResult[]>;

/** Adapt a nostr-tools {@link SimplePool} to a {@link PublishFn}. */
export function simplePoolPublisher(pool: SimplePool): PublishFn {
  return async (relays, event) => {
    const settled = await Promise.allSettled(pool.publish(relays, event));
    return settled.map((r, i) => {
      const relay = relays[i] ?? '';
      if (r.status === 'rejected') return { relay, ok: false, error: String(r.reason) };
      // A successful publish resolves with the relay's OK reason, but nostr-tools also *resolves*
      // (rather than rejects) on connection/skip failures with a marker string — treat those as
      // failures so we never report a false "OK".
      const reason = String(r.value ?? '');
      if (/^(connection failure:|connection skipped|duplicate url)/.test(reason)) {
        return { relay, ok: false, error: reason };
      }
      return { relay, ok: true };
    });
  };
}
