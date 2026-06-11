import { KINDS } from '@openauspex/core';
import type { Alarm, CanaryState } from '@openauspex/core';
import type { EventTemplate } from 'nostr-tools';

import type { MonitorReport } from './assess.js';

/** A consumer of monitor reports (print, webhook, re-broadcast, …). */
export type AlertSink = (report: MonitorReport) => void | Promise<void>;

/** Render a report as a concise multi-line summary. */
export function formatReport(report: MonitorReport): string {
  const { evaluation: e, definition: d } = report;
  const lines = [`canary ${d.id}: ${e.state.toUpperCase()}`];
  if (e.deadline !== undefined) {
    lines.push(`  next deadline: ${new Date(e.deadline * 1000).toISOString()}`);
  }
  lines.push(`  fresh signers: ${e.freshSigners.length}/${e.threshold}`);
  for (const a of e.alarms) lines.push(`  ⚠ ${a.kind}: ${a.message}`);
  for (const inv of report.issues) {
    const codes = inv.issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.code)
      .join(', ');
    lines.push(`  ✗ invalid ${inv.eventId.slice(0, 8)}…: ${codes}`);
  }
  return lines.join('\n');
}

/**
 * Build a (placeholder-kind) `canary-alert` event re-broadcasting an alarm to the watcher mesh.
 * Censoring the record then requires censoring every watcher too.
 */
export function buildCanaryAlert(params: {
  definitionAddr: string;
  state: CanaryState;
  alarms: Alarm[];
  created_at?: number;
}): EventTemplate {
  return {
    kind: KINDS.CANARY_ALERT,
    created_at: params.created_at ?? Math.floor(Date.now() / 1000),
    content: JSON.stringify({ state: params.state, alarms: params.alarms }),
    tags: [
      ['a', params.definitionAddr],
      ['alt', `OpenAuspex alert: ${params.state}`],
    ],
  };
}
