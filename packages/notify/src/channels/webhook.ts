import type { Notification } from '../types.js';
import type { NotificationChannel } from './channel.js';

export interface WebhookOptions {
  /** Destination URL; the notification is POSTed as a JSON body. */
  url: string;
  /** Extra request headers (e.g. an auth token). */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Injectable `fetch` (defaults to the global) — for testing. */
  fetch?: typeof fetch;
}

/**
 * POSTs each notification as a JSON body to a URL. Generic by design — point it at an ntfy topic, a
 * Discord/Slack relay, or your own endpoint. A non-2xx response throws so {@link dispatch} records
 * the failure.
 */
export class WebhookChannel implements NotificationChannel {
  readonly name: string;
  constructor(private readonly opts: WebhookOptions) {
    this.name = `webhook(${opts.url})`;
  }

  async send(notification: Notification): Promise<void> {
    const doFetch = this.opts.fetch ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await doFetch(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.headers },
        body: JSON.stringify(notification),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`webhook ${this.opts.url} → HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
