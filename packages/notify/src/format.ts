import type { Notification, NotificationSeverity } from './types.js';

const ICON: Record<NotificationSeverity, string> = {
  info: 'ℹ',
  warn: '⚠',
  critical: '🚨',
};

/** Render a duration in seconds as a compact `2d 3h` / `45m` / `<1m` string. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && !days) parts.push(`${minutes}m`);
  return parts.join(' ') || '<1m';
}

/** Render a notification as a concise multi-line block for terminals/logs. */
export function formatNotification(n: Notification): string {
  const when = new Date(n.at * 1000).toISOString();
  return `${ICON[n.severity]} [${n.severity.toUpperCase()}] ${n.title}\n  ${n.body}\n  (${n.kind} · ${when})`;
}
