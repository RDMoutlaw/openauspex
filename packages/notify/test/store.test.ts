import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileNotifyStore, MemoryNotifyStore, emptyNotifyState } from '../src/store';
import type { NotifyState } from '../src/store';

const sample: NotifyState = {
  lastState: 'alive',
  notifiedAlarms: ['clause-drop|no-backdoor|s|e1'],
  reminder: { deadline: 1_700_000_000, firedLeadTimes: [259200], overdueFired: false },
  updatedAt: 1_700_000_000,
};

describe('emptyNotifyState', () => {
  it('starts with no remembered alarms and no last state', () => {
    expect(emptyNotifyState()).toEqual({ notifiedAlarms: [] });
  });
});

describe('MemoryNotifyStore', () => {
  it('returns an empty state for an unknown canary and round-trips writes', () => {
    const store = new MemoryNotifyStore();
    expect(store.get('primary')).toEqual(emptyNotifyState());
    store.set('primary', sample);
    expect(store.get('primary')).toEqual(sample);
  });
});

describe('FileNotifyStore', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auspex-notify-'));
    path = join(dir, 'nested', 'notify-state.json'); // nested → exercises mkdir
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty state before anything is written', () => {
    expect(new FileNotifyStore(path).get('primary')).toEqual(emptyNotifyState());
  });

  it('persists across instances and keeps canaries separate in one file', () => {
    const a = new FileNotifyStore(path);
    a.set('primary', sample);
    a.set('secondary', { ...emptyNotifyState(), lastState: 'dead' });

    const b = new FileNotifyStore(path); // fresh instance reads the same file
    expect(b.get('primary')).toEqual(sample);
    expect(b.get('secondary').lastState).toBe('dead');
    expect(b.get('unseen')).toEqual(emptyNotifyState());
  });
});
