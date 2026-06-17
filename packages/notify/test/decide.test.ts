import { describe, expect, it } from 'vitest';
import type { Alarm, CanaryDefinition, Evaluation } from '@openauspex/core';
import type { MonitorReport } from '@openauspex/monitor';

import { decide, decideReminder } from '../src/decide';
import { emptyNotifyState } from '../src/store';
import type { NotifyState } from '../src/store';

const DEF: CanaryDefinition = {
  id: 'primary',
  pubkey: 'pk',
  content: '',
  cadence: 100,
  grace: 10,
  freshness: {},
  statements: [],
  signers: [],
  threshold: 1,
};

/** Minimal monitor report — decide only reads `evaluation` and `definition.id`. */
function report(ev: Partial<Evaluation> & Pick<Evaluation, 'state'>): MonitorReport {
  return {
    definition: DEF,
    evaluation: { alarms: [], freshSigners: [], threshold: 1, ...ev },
    attestations: [],
    issues: [],
  };
}

const NOW = 1_700_000_000;

describe('decide — lifecycle transitions', () => {
  it('stays silent on a healthy first observation, but records the baseline', () => {
    const { notifications, state } = decide(report({ state: 'alive', freshSigners: ['s'] }), emptyNotifyState(), {
      now: NOW,
    });
    expect(notifications).toHaveLength(0);
    expect(state.lastState).toBe('alive');
  });

  it('notifies on an unhealthy first observation', () => {
    const { notifications } = decide(report({ state: 'dead' }), emptyNotifyState(), { now: NOW });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe('canary-dead');
    expect(notifications[0]?.severity).toBe('critical');
  });

  it('notifies on alive → dead', () => {
    const prior: NotifyState = { lastState: 'alive', notifiedAlarms: [] };
    const { notifications, state } = decide(report({ state: 'dead' }), prior, { now: NOW });
    expect(notifications.map((n) => n.kind)).toEqual(['canary-dead']);
    expect(state.lastState).toBe('dead');
  });

  it('notifies on recovery dead → alive by default, and suppresses it when notifyOnRecovery is false', () => {
    const prior: NotifyState = { lastState: 'dead', notifiedAlarms: [] };
    const r = report({ state: 'alive', freshSigners: ['s'] });

    expect(decide(r, prior, { now: NOW }).notifications.map((n) => n.kind)).toEqual(['canary-alive']);

    const suppressed = decide(r, prior, { now: NOW, notifyOnRecovery: false });
    expect(suppressed.notifications).toHaveLength(0);
    expect(suppressed.state.lastState).toBe('alive'); // still advances the baseline
  });

  it('does not re-notify a steady state', () => {
    const prior: NotifyState = { lastState: 'dead', notifiedAlarms: [] };
    expect(decide(report({ state: 'dead' }), prior, { now: NOW }).notifications).toHaveLength(0);
  });
});

describe('decide — confirmations debounce', () => {
  it('requires N consecutive observations before alerting', () => {
    const r = report({ state: 'dead' });
    const first = decide(r, { lastState: 'alive', notifiedAlarms: [] }, { now: NOW, confirmations: 2 });
    expect(first.notifications).toHaveLength(0);
    expect(first.state.candidateState).toBe('dead');
    expect(first.state.candidateStreak).toBe(1);
    expect(first.state.lastState).toBe('alive'); // not yet confirmed

    const second = decide(r, first.state, { now: NOW + 60, confirmations: 2 });
    expect(second.notifications.map((n) => n.kind)).toEqual(['canary-dead']);
    expect(second.state.lastState).toBe('dead');
    expect(second.state.candidateState).toBeUndefined();
  });

  it('absorbs a one-poll blip (does not alert)', () => {
    // dead seen once, then back to alive before the 2nd confirmation.
    const blip = decide(report({ state: 'dead' }), { lastState: 'alive', notifiedAlarms: [] }, { now: NOW, confirmations: 2 });
    const recovered = decide(report({ state: 'alive', freshSigners: ['s'] }), blip.state, { now: NOW + 60, confirmations: 2 });
    expect(recovered.notifications).toHaveLength(0);
    expect(recovered.state.lastState).toBe('alive');
    expect(recovered.state.candidateState).toBeUndefined();
  });
});

describe('decide — alarms', () => {
  const clauseDrop: Alarm = { kind: 'clause-drop', clause: 'no-backdoor', signer: 's', eventId: 'e1', message: 'dropped' };

  it('emits each new alarm once and de-duplicates thereafter', () => {
    const first = decide(report({ state: 'alive', freshSigners: ['s'], alarms: [clauseDrop] }), emptyNotifyState(), { now: NOW });
    expect(first.notifications.map((n) => n.kind)).toContain('clause-drop');
    const dropNote = first.notifications.find((n) => n.kind === 'clause-drop');
    expect(dropNote?.severity).toBe('critical');

    const second = decide(report({ state: 'alive', freshSigners: ['s'], alarms: [clauseDrop] }), first.state, { now: NOW + 60 });
    expect(second.notifications).toHaveLength(0);
  });

  it('does not double-report the `dead` alarm — the canary-dead transition covers it', () => {
    const deadAlarm: Alarm = { kind: 'dead', message: 'no fresh signers' };
    const { notifications } = decide(report({ state: 'dead', alarms: [deadAlarm] }), { lastState: 'alive', notifiedAlarms: [] }, { now: NOW });
    expect(notifications.map((n) => n.kind)).toEqual(['canary-dead']);
  });

  it('fires alarms immediately even while a state change is still being confirmed', () => {
    const { notifications } = decide(
      report({ state: 'dead', alarms: [clauseDrop] }),
      { lastState: 'alive', notifiedAlarms: [] },
      { now: NOW, confirmations: 3 },
    );
    expect(notifications.map((n) => n.kind)).toEqual(['clause-drop']); // dead not yet confirmed
  });
});

describe('decideReminder', () => {
  const deadline = NOW + 10 * 86_400;
  const alive = (): MonitorReport => report({ state: 'alive', freshSigners: ['s'], deadline });
  const leadTimes = [3 * 86_400, 86_400, 3_600];

  it('says nothing while the deadline is far away', () => {
    const { notifications } = decideReminder(alive(), emptyNotifyState(), { now: NOW, leadTimes });
    expect(notifications).toHaveLength(0);
  });

  it('reminds once as a lead threshold is crossed, then not again for the same threshold', () => {
    const now = deadline - 2 * 86_400; // inside the 3-day window
    const first = decideReminder(alive(), emptyNotifyState(), { now, leadTimes });
    expect(first.notifications.map((n) => n.kind)).toEqual(['reminder-due']);
    expect(first.state.reminder?.firedLeadTimes).toContain(3 * 86_400);

    const again = decideReminder(alive(), first.state, { now: now + 60, leadTimes });
    expect(again.notifications).toHaveLength(0);
  });

  it('escalates through successive thresholds across the period', () => {
    let state = emptyNotifyState();
    const fire = (now: number): string[] => {
      const res = decideReminder(alive(), state, { now, leadTimes });
      state = res.state;
      return res.notifications.map((n) => n.kind);
    };
    expect(fire(deadline - 2 * 86_400)).toEqual(['reminder-due']); // crosses 3d
    expect(fire(deadline - 12 * 3_600)).toEqual(['reminder-due']); // crosses 1d
    expect(fire(deadline - 30 * 60)).toEqual(['reminder-due']); // crosses 1h
    expect(fire(deadline + 60)).toEqual(['reminder-overdue']); // past deadline
    expect(fire(deadline + 120)).toEqual([]); // overdue only once
  });

  it('collapses several thresholds crossed in one sparse poll into a single reminder', () => {
    const now = deadline - 30 * 60; // crosses 3d, 1d, and 1h at once
    const { notifications, state } = decideReminder(alive(), emptyNotifyState(), { now, leadTimes });
    expect(notifications).toHaveLength(1);
    expect(state.reminder?.firedLeadTimes.sort((a, b) => a - b)).toEqual([...leadTimes].sort((a, b) => a - b));
  });

  it('re-arms when the operator re-attests and the deadline advances', () => {
    const now = deadline - 30 * 60;
    const first = decideReminder(alive(), emptyNotifyState(), { now, leadTimes });
    expect(first.notifications).toHaveLength(1);

    const newDeadline = deadline + 30 * 86_400;
    const after = decideReminder(report({ state: 'alive', freshSigners: ['s'], deadline: newDeadline }), first.state, {
      now: newDeadline - 30 * 60,
      leadTimes,
    });
    expect(after.notifications.map((n) => n.kind)).toEqual(['reminder-due']);
    expect(after.state.reminder?.deadline).toBe(newDeadline);
  });

  it('is silent for canaries that no longer expect re-attestation', () => {
    expect(decideReminder(report({ state: 'unknown' }), emptyNotifyState(), { now: NOW, leadTimes }).notifications).toHaveLength(0);
    expect(decideReminder(report({ state: 'retired' }), emptyNotifyState(), { now: NOW, leadTimes }).notifications).toHaveLength(0);
  });
});

describe('decide + decideReminder share one state without clobbering', () => {
  it('preserves alarm/lifecycle fields through a reminder run and vice-versa', () => {
    const deadline = NOW + 2 * 86_400;
    const r = report({ state: 'alive', freshSigners: ['s'], deadline, alarms: [] });

    const a = decide(r, emptyNotifyState(), { now: NOW });
    const b = decideReminder(r, a.state, { now: NOW, leadTimes: [3 * 86_400] });
    expect(b.state.lastState).toBe('alive'); // lifecycle field survived the reminder write
    expect(b.notifications.map((n) => n.kind)).toEqual(['reminder-due']);

    const c = decide(r, b.state, { now: NOW + 60 });
    expect(c.state.reminder?.firedLeadTimes).toContain(3 * 86_400); // reminder field survived the decide write
  });
});
