import { formatNotification } from '../format.js';
import type { Notification } from '../types.js';
import type { NotificationChannel } from './channel.js';

/**
 * Writes notifications to the terminal. The writer is injectable (defaults to `console.log`), which
 * keeps the channel pure for tests and lets callers redirect output.
 */
export class ConsoleChannel implements NotificationChannel {
  readonly name = 'console';
  constructor(private readonly write: (text: string) => void = (t) => console.log(t)) {}

  send(notification: Notification): void {
    this.write(formatNotification(notification));
  }
}
