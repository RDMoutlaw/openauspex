import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A stamp awaiting (or having completed) its OpenTimestamps → kind-1040 lifecycle. */
export interface PendingStamp {
  /** Event id of the attestation being timestamped. */
  eventId: string;
  /** Kind of the timestamped event (1772). */
  eventKind: number;
  /** base64-encoded OTS proof (pending until upgraded to a Bitcoin attestation). */
  proof: string;
  /** Relays the kind-1040 should be published to. */
  relays: string[];
  createdAt: number;
  /** Set once the kind-1040 has been published. */
  resolvedAt?: number;
}

export interface PendingStore {
  list(): PendingStamp[];
  add(stamp: PendingStamp): void;
  update(eventId: string, patch: Partial<PendingStamp>): void;
}

/** Non-persistent store (tests / ephemeral use). */
export class MemoryStore implements PendingStore {
  private readonly stamps = new Map<string, PendingStamp>();
  list(): PendingStamp[] {
    return [...this.stamps.values()];
  }
  add(stamp: PendingStamp): void {
    this.stamps.set(stamp.eventId, stamp);
  }
  update(eventId: string, patch: Partial<PendingStamp>): void {
    const cur = this.stamps.get(eventId);
    if (cur) this.stamps.set(eventId, { ...cur, ...patch });
  }
}

/** JSON-file-backed store for the two-phase publish → upgrade workflow. */
export class FileStore implements PendingStore {
  constructor(private readonly path: string) {}

  private read(): PendingStamp[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, 'utf8')) as PendingStamp[];
  }

  private write(stamps: PendingStamp[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(stamps, null, 2));
  }

  list(): PendingStamp[] {
    return this.read();
  }
  add(stamp: PendingStamp): void {
    const all = this.read();
    all.push(stamp);
    this.write(all);
  }
  update(eventId: string, patch: Partial<PendingStamp>): void {
    this.write(this.read().map((s) => (s.eventId === eventId ? { ...s, ...patch } : s)));
  }
}
