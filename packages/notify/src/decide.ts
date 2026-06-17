import type { Alarm, AlarmKind, CanaryState, Evaluation } from '@openauspex/core';
import type { MonitorReport } from '@openauspex/monitor';

import { formatDuration } from './format.js';
import type { NotifyState, ReminderProgress } from './store.js';
import type { Notification, NotificationKind, NotificationSeverity } from './types.js';

/** Default lead window before a deadline at which `decideReminder` nudges (3 days). */
export const DEFAULT_REMINDER_LEAD_SECONDS = 3 * 86_400;

const SEVERITY_BY_STATE: Record<CanaryState, NotificationSeverity> = {
  alive: 'info',
  dead: 'critical',
  retired: 'info',
  terminated: 'warn',
  unknown: 'warn',
};

const SEVERITY_BY_ALARM: Record<Exclude<AlarmKind, 'dead'>, NotificationSeverity> = {
  'clause-drop': 'critical',
  'definition-drift': 'warn',
  'back-dated': 'critical',
};

export interface DecideOptions {
  /** The evaluating clock (unix seconds) — stamps the notifications. */
  now: number;
  /**
   * Consecutive observations of a new state required before it notifies — a debounce that absorbs
   * transient relay/explorer blips (a single failed fetch can momentarily read `dead`/`unknown`).
   * Default 1 (notify immediately).
   */
  confirmations?: number;
  /** Notify when the canary recovers to `alive` from another state. Default `true`. */
  notifyOnRecovery?: boolean;
  /**
   * Suppress a notification for the very first observation when the canary is healthy (`alive`), so
   * wiring up the notifier on a live canary is silent. Default `true`. An unhealthy first observation
   * always notifies (once confirmed).
   */
  baselineSilently?: boolean;
}

export interface ReminderOptions {
  /** The evaluating clock (unix seconds). */
  now: number;
  /**
   * Lead windows (seconds before the deadline) at which to remind — one notification as each
   * threshold is first crossed, escalating as the deadline nears (e.g. `[259200, 86400, 3600]` →
   * 3 days, 1 day, 1 hour out). Defaults to `[DEFAULT_REMINDER_LEAD_SECONDS]`.
   */
  leadTimes?: number[];
}

export interface DecideResult {
  /** Notifications to deliver this run (empty when nothing changed). */
  notifications: Notification[];
  /** The state to persist for the next run. */
  state: NotifyState;
}

/** Stable identity of an alarm, so the same alarm is not re-notified across runs. */
function alarmKey(a: Alarm): string {
  return [a.kind, a.clause ?? '', a.signer ?? '', a.eventId ?? ''].join('|');
}

/**
 * Decide which watcher-facing notifications a monitor report warrants, given what was last seen.
 * Pure and deterministic.
 *
 * A lifecycle {@link CanaryState} change notifies only after it has been observed `confirmations`
 * times in a row (debounce). Each newly-seen alarm (clause-drop / definition-drift / back-dated)
 * notifies once; alarms are content-derived and only fire on real data, so they are not debounced.
 * The `dead` alarm is omitted because the `canary-dead` transition already conveys liveness loss.
 */
export function decide(report: MonitorReport, prior: NotifyState, opts: DecideOptions): DecideResult {
  const { now } = opts;
  const confirmations = Math.max(1, opts.confirmations ?? 1);
  const notifyOnRecovery = opts.notifyOnRecovery ?? true;
  const baselineSilently = opts.baselineSilently ?? true;
  const { evaluation, definition } = report;
  const observed = evaluation.state;
  const notifications: Notification[] = [];

  // 1) Lifecycle transition, debounced by `confirmations` consecutive observations.
  let lastState = prior.lastState;
  let candidateState = prior.candidateState;
  let candidateStreak = prior.candidateStreak ?? 0;

  if (observed === lastState) {
    // Back to (or still at) the confirmed state — cancel any in-flight candidate.
    candidateState = undefined;
    candidateStreak = 0;
  } else {
    candidateStreak = observed === candidateState ? candidateStreak + 1 : 1;
    candidateState = observed;
    if (candidateStreak >= confirmations) {
      const previous = lastState;
      const firstRunHealthy = previous === undefined && observed === 'alive';
      const recovery = previous !== undefined && observed === 'alive';
      const suppress = (firstRunHealthy && baselineSilently) || (recovery && !notifyOnRecovery);
      if (!suppress) notifications.push(stateNotification(definition.id, evaluation, now, previous));
      lastState = observed;
      candidateState = undefined;
      candidateStreak = 0;
    }
  }

  // 2) Alarms, each once. Keys include the event id, so a freshly-flagged attestation re-notifies.
  const known = new Set(prior.notifiedAlarms);
  for (const alarm of evaluation.alarms) {
    if (alarm.kind === 'dead') continue;
    const key = alarmKey(alarm);
    if (!known.has(key)) {
      known.add(key);
      notifications.push(alarmNotification(definition.id, alarm, now));
    }
  }

  return {
    notifications,
    state: {
      ...prior,
      lastState,
      candidateState,
      candidateStreak,
      notifiedAlarms: [...known].sort(),
      updatedAt: now,
    },
  };
}

/**
 * Decide whether to nudge the operator to re-attest. Pure. Fires a `reminder-due` as each lead
 * threshold is first crossed, then a single `reminder-overdue` once the deadline has passed — each
 * at most once per attestation period (re-attesting advances the deadline, which re-arms them all).
 * If several thresholds are crossed within one sparse poll, the single notification reports the
 * current time-remaining and all crossed thresholds are marked done. Silent for canaries that no
 * longer expect re-attestation (`retired` / `terminated` / `unknown`).
 */
export function decideReminder(report: MonitorReport, prior: NotifyState, opts: ReminderOptions): DecideResult {
  const { now } = opts;
  const leadTimes = opts.leadTimes && opts.leadTimes.length ? opts.leadTimes : [DEFAULT_REMINDER_LEAD_SECONDS];
  const { evaluation, definition } = report;
  const notifications: Notification[] = [];

  const deadline = evaluation.deadline;
  const expectsReattestation = evaluation.state === 'alive' || evaluation.state === 'dead';
  if (deadline === undefined || !expectsReattestation) {
    return { notifications, state: { ...prior, updatedAt: now } };
  }

  // Track progress per deadline; a new deadline (operator re-attested) resets the counters.
  const progress: ReminderProgress =
    prior.reminder && prior.reminder.deadline === deadline
      ? { ...prior.reminder, firedLeadTimes: [...prior.reminder.firedLeadTimes] }
      : { deadline, firedLeadTimes: [], overdueFired: false };

  const remaining = deadline - now;
  if (remaining <= 0) {
    if (!progress.overdueFired) {
      notifications.push(reminderNotification(definition.id, evaluation, now, remaining, true));
      progress.overdueFired = true;
    }
  } else {
    const crossed = leadTimes.filter((lt) => remaining <= lt && !progress.firedLeadTimes.includes(lt));
    if (crossed.length > 0) {
      notifications.push(reminderNotification(definition.id, evaluation, now, remaining, false));
      progress.firedLeadTimes = [...progress.firedLeadTimes, ...crossed].sort((a, b) => b - a);
    }
  }

  return { notifications, state: { ...prior, reminder: progress, updatedAt: now } };
}

function stateNotification(canaryId: string, e: Evaluation, now: number, previous?: CanaryState): Notification {
  const fresh = `${e.freshSigners.length}/${e.threshold} required signer(s) fresh`;
  const transition = previous ? `${previous} → ${e.state}` : `now ${e.state}`;
  const deadlineIso = e.deadline !== undefined ? new Date(e.deadline * 1000).toISOString() : undefined;

  let title: string;
  let body: string;
  switch (e.state) {
    case 'alive':
      title = `Canary ${canaryId} is alive`;
      body = `${previous ? `Recovered (${transition}). ` : ''}${fresh}${deadlineIso ? `; next deadline ${deadlineIso}.` : '.'}`;
      break;
    case 'dead':
      title = `Canary ${canaryId} is DEAD`;
      body = `Liveness lapsed (${transition}). ${fresh} within cadence + grace — the canary has stopped affirming.`;
      break;
    case 'retired':
      title = `Canary ${canaryId} retired`;
      body = `The operator marked this canary retired (${transition}) — an orderly wind-down, not a missed attestation.`;
      break;
    case 'terminated':
      title = `Canary ${canaryId} terminated`;
      body = `The operator marked this canary terminated (${transition}). Stop relying on it; confirm the shutdown was intended.`;
      break;
    case 'unknown':
      title = `Canary ${canaryId} is unverifiable`;
      body = `No valid attestation could be evaluated (${transition}) — not yet attested, or its records are unreachable.`;
      break;
  }

  return {
    kind: `canary-${e.state}` as NotificationKind,
    severity: SEVERITY_BY_STATE[e.state],
    canaryId,
    title,
    body,
    at: now,
    data: {
      state: e.state,
      previousState: previous,
      freshSigners: e.freshSigners.length,
      threshold: e.threshold,
      deadline: e.deadline,
      lastAttestationTime: e.lastAttestationTime,
      alarms: e.alarms,
    },
  };
}

function alarmNotification(canaryId: string, alarm: Alarm, now: number): Notification {
  const kind = alarm.kind as Exclude<AlarmKind, 'dead'>;
  const titles: Record<Exclude<AlarmKind, 'dead'>, string> = {
    'clause-drop': `Canary ${canaryId} dropped a clause`,
    'definition-drift': `Canary ${canaryId} definition loosened`,
    'back-dated': `Canary ${canaryId} attestation looks back-dated`,
  };
  return {
    kind,
    severity: SEVERITY_BY_ALARM[kind],
    canaryId,
    title: titles[kind],
    body: alarm.message,
    at: now,
    data: { ...alarm },
  };
}

function reminderNotification(
  canaryId: string,
  e: Evaluation,
  now: number,
  remaining: number,
  overdue: boolean,
): Notification {
  const deadlineIso = e.deadline !== undefined ? new Date(e.deadline * 1000).toISOString() : 'unknown';
  return {
    kind: overdue ? 'reminder-overdue' : 'reminder-due',
    severity: overdue ? 'critical' : 'warn',
    canaryId,
    title: overdue ? `Canary ${canaryId} attestation OVERDUE` : `Canary ${canaryId} attestation due soon`,
    body: overdue
      ? `The attestation deadline (${deadlineIso}) passed ${formatDuration(-remaining)} ago. Re-attest now, or watchers will read the canary as dead.`
      : `Re-attest within ${formatDuration(remaining)} (by ${deadlineIso}) to keep the canary alive.`,
    at: now,
    data: {
      deadline: e.deadline,
      remainingSeconds: remaining,
      overdue,
      lastAttestationTime: e.lastAttestationTime,
    },
  };
}
