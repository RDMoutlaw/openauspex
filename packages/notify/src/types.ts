import type { AlarmKind, CanaryState } from '@openauspex/core';

/** Severity used to route, colour, and prioritise a notification. */
export type NotificationSeverity = 'info' | 'warn' | 'critical';

/**
 * What a notification is about:
 * - `canary-*` — a lifecycle transition derived from the evaluated {@link CanaryState}.
 * - the alarm kinds (`clause-drop` | `definition-drift` | `back-dated`) mirror core's
 *   {@link AlarmKind}, minus `dead` (the `canary-dead` transition already reports liveness loss).
 * - `reminder-*` — operator-facing nudges to re-attest before (or after) the deadline.
 */
export type NotificationKind =
  | `canary-${CanaryState}`
  | Exclude<AlarmKind, 'dead'>
  | 'reminder-due'
  | 'reminder-overdue';

/** A single thing worth telling a human or a machine about. Channel-agnostic. */
export interface Notification {
  kind: NotificationKind;
  severity: NotificationSeverity;
  /** The canary `d` id this concerns. */
  canaryId: string;
  /** One-line headline. */
  title: string;
  /** Human-readable detail. */
  body: string;
  /** Unix seconds when the notification was generated (the evaluating `now`). */
  at: number;
  /** Structured payload for machine consumers (e.g. webhooks). */
  data?: Record<string, unknown>;
}
