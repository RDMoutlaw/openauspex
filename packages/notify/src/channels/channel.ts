import type { Notification } from '../types.js';

/** A delivery target for notifications (terminal, webhook, push service, …). */
export interface NotificationChannel {
  /** Human-readable label, used in dispatch results and logs. */
  readonly name: string;
  send(notification: Notification): Promise<void> | void;
}

/** Outcome of delivering one notification to one channel. */
export interface DispatchResult {
  channel: string;
  notification: Notification;
  ok: boolean;
  error?: string;
}

/**
 * Deliver every notification through every channel. Failures are isolated: one channel (or one
 * notification) throwing never prevents the rest from being delivered — the error is captured in
 * the returned {@link DispatchResult} list instead.
 */
export async function dispatch(
  notifications: Notification[],
  channels: NotificationChannel[],
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  for (const notification of notifications) {
    for (const channel of channels) {
      try {
        await channel.send(notification);
        results.push({ channel: channel.name, notification, ok: true });
      } catch (e) {
        results.push({ channel: channel.name, notification, ok: false, error: (e as Error).message });
      }
    }
  }
  return results;
}
