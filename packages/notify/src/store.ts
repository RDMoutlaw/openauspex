import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CanaryState } from '@openauspex/core';

/** Reminder progress for one attestation deadline; reset when the deadline advances. */
export interface ReminderProgress {
  /** The deadline (unix s) these counters pertain to. */
  deadline: number;
  /** Lead thresholds (seconds) already notified for this deadline. */
  firedLeadTimes: number[];
  /** Whether the post-deadline "overdue" reminder has been sent for this deadline. */
  overdueFired: boolean;
}

/**
 * What the notifier remembers between runs so it alerts on *changes*, not on every poll. Designed
 * to be safe to run on a timer: re-emitting the same notification each cycle would be noise.
 */
export interface NotifyState {
  /** Last *confirmed* lifecycle state (what we last notified or baselined). */
  lastState?: CanaryState;
  /** A differing state currently under debounce confirmation (undefined when stable). */
  candidateState?: CanaryState;
  /** Consecutive observations of {@link candidateState}, toward the `confirmations` threshold. */
  candidateStreak?: number;
  /** Stable keys of alarms already notified, so each distinct alarm fires exactly once. */
  notifiedAlarms: string[];
  /** Per-deadline reminder progress. */
  reminder?: ReminderProgress;
  /** Unix seconds of the run that last wrote this state. */
  updatedAt?: number;
}

/** A fresh, never-notified state. */
export const emptyNotifyState = (): NotifyState => ({ notifiedAlarms: [] });

/** Persists {@link NotifyState} per canary id across notifier runs. */
export interface NotifyStateStore {
  get(canaryId: string): NotifyState;
  set(canaryId: string, state: NotifyState): void;
}

/** Non-persistent store (tests / ephemeral use). */
export class MemoryNotifyStore implements NotifyStateStore {
  private readonly states = new Map<string, NotifyState>();
  get(canaryId: string): NotifyState {
    return this.states.get(canaryId) ?? emptyNotifyState();
  }
  set(canaryId: string, state: NotifyState): void {
    this.states.set(canaryId, state);
  }
}

/** JSON-file-backed store; one file holds a map of `{ [canaryId]: NotifyState }`. */
export class FileNotifyStore implements NotifyStateStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, NotifyState> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, NotifyState>;
  }

  private write(all: Record<string, NotifyState>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(all, null, 2));
  }

  get(canaryId: string): NotifyState {
    return this.read()[canaryId] ?? emptyNotifyState();
  }

  set(canaryId: string, state: NotifyState): void {
    const all = this.read();
    all[canaryId] = state;
    this.write(all);
  }
}
