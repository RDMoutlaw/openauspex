import { Buffer } from 'node:buffer';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import {
  buildAttestation,
  buildDefinition,
  buildOtsAttestation,
  getBlockByHeight,
  isOtsComplete,
  stampEventId,
  upgradeProof,
} from '@openauspex/core';
import type {
  BitcoinProvider,
  BuildDefinitionParams,
  CanaryStatus,
  NostrEvent,
} from '@openauspex/core';

import type { PublishFn, PublishResult } from './publish.js';
import type { PendingStore } from './store.js';

/** Injectable OpenTimestamps operations (defaults call the real calendars / explorers). */
export interface OtsOps {
  stamp?: (eventId: string) => Promise<Uint8Array>;
  upgrade?: (proof: Uint8Array) => Promise<{ upgraded: boolean; proof: Uint8Array }>;
  /** Whether the proof carries a complete Bitcoin attestation (self-contained, calendar-free). */
  isComplete?: (proof: Uint8Array) => boolean;
}

export interface PublisherOptions {
  /** This signer's secret key. */
  secretKey: Uint8Array;
  relays: string[];
  /** The definition author's pubkey; defaults to this signer (single-author canary). */
  definitionPubkey?: string;
  provider: BitcoinProvider;
  publish: PublishFn;
  store: PendingStore;
  ots?: OtsOps;
  /** Clock (unix seconds); injectable for tests. */
  now?: () => number;
}

export interface AttestResult {
  event: NostrEvent;
  anchor: { height: number; hash: string };
  publish: PublishResult[];
  stamped: boolean;
}

export interface UpgradeReport {
  eventId: string;
  complete: boolean;
  published: boolean;
}

/**
 * Operator-side publisher. `attest` performs phase 1 (anchor → sign → publish → stamp); `upgradePending`
 * performs phase 2 (upgrade the OTS proof, then publish the NIP-03 kind-1040 once it is complete).
 */
export class Publisher {
  private readonly pk: string;
  private readonly stamp: (eventId: string) => Promise<Uint8Array>;
  private readonly upgrade: (proof: Uint8Array) => Promise<{ upgraded: boolean; proof: Uint8Array }>;
  private readonly isComplete: (proof: Uint8Array) => boolean;
  private readonly now: () => number;

  constructor(private readonly opts: PublisherOptions) {
    this.pk = getPublicKey(opts.secretKey);
    this.stamp = opts.ots?.stamp ?? stampEventId;
    this.upgrade = opts.ots?.upgrade ?? upgradeProof;
    this.isComplete = opts.ots?.isComplete ?? isOtsComplete;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get pubkey(): string {
    return this.pk;
  }

  /** Build, sign, and publish a Canary Definition. */
  async publishDefinition(
    params: BuildDefinitionParams,
  ): Promise<{ event: NostrEvent; publish: PublishResult[] }> {
    const event = finalizeEvent(buildDefinition(params), this.opts.secretKey);
    return { event, publish: await this.opts.publish(this.opts.relays, event) };
  }

  /** Phase 1: anchor a recent block, sign, publish, and (by default) OpenTimestamp the attestation. */
  async attest(params: {
    canaryId: string;
    affirms: string[];
    status?: CanaryStatus;
    statusReason?: string;
    content?: string;
    alt?: string;
    /** Set false to skip OTS stamping. */
    stamp?: boolean;
  }): Promise<AttestResult> {
    const tip = await this.opts.provider.getTipHeight();
    const block = await getBlockByHeight(this.opts.provider, tip);
    const anchor = { height: block.height, hash: block.hash };

    const event = finalizeEvent(
      buildAttestation({
        definitionPubkey: this.opts.definitionPubkey ?? this.pk,
        canaryId: params.canaryId,
        affirms: params.affirms,
        anchor,
        status: params.status,
        statusReason: params.statusReason,
        content: params.content,
        alt: params.alt,
        created_at: this.now(),
      }),
      this.opts.secretKey,
    );

    const publish = await this.opts.publish(this.opts.relays, event);

    let stamped = false;
    if (params.stamp !== false) {
      const proof = await this.stamp(event.id);
      this.opts.store.add({
        eventId: event.id,
        eventKind: event.kind,
        proof: Buffer.from(proof).toString('base64'),
        relays: this.opts.relays,
        createdAt: this.now(),
      });
      stamped = true;
    }

    return { event, anchor, publish, stamped };
  }

  /** Phase 2: upgrade each unresolved stamp; publish its kind-1040 once a Bitcoin attestation exists. */
  async upgradePending(): Promise<UpgradeReport[]> {
    const reports: UpgradeReport[] = [];
    for (const stamp of this.opts.store.list()) {
      if (stamp.resolvedAt) continue;

      const current = new Uint8Array(Buffer.from(stamp.proof, 'base64'));
      const { upgraded, proof } = await this.upgrade(current);
      const latest = upgraded ? proof : current;
      if (upgraded) {
        this.opts.store.update(stamp.eventId, { proof: Buffer.from(latest).toString('base64') });
      }

      // Only publish once the proof carries a *complete* Bitcoin attestation — a self-contained
      // NIP-03 proof that verifies against the chain alone. Calendars serve this once their
      // transaction has enough confirmations (~6); until then, leave it pending and retry later.
      if (!this.isComplete(latest)) {
        reports.push({ eventId: stamp.eventId, complete: false, published: false });
        continue;
      }

      const otsEvent = finalizeEvent(
        buildOtsAttestation({ eventId: stamp.eventId, eventKind: stamp.eventKind, proof: latest }),
        this.opts.secretKey,
      );
      await this.opts.publish(stamp.relays, otsEvent);
      this.opts.store.update(stamp.eventId, { resolvedAt: this.now() });
      reports.push({ eventId: stamp.eventId, complete: true, published: true });
    }
    return reports;
  }
}
