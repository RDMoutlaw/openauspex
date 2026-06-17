import { describe, expect, it } from 'vitest';

import { ConsoleChannel, WebhookChannel, dispatch } from '../src/channels/index';
import type { NotificationChannel } from '../src/channels/index';
import type { Notification } from '../src/types';

const note = (over: Partial<Notification> = {}): Notification => ({
  kind: 'canary-dead',
  severity: 'critical',
  canaryId: 'primary',
  title: 'Canary primary is DEAD',
  body: 'Liveness lapsed.',
  at: 1_700_000_000,
  ...over,
});

describe('ConsoleChannel', () => {
  it('writes a formatted line through the injected writer', () => {
    const lines: string[] = [];
    new ConsoleChannel((t) => lines.push(t)).send(note());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Canary primary is DEAD');
    expect(lines[0]).toContain('CRITICAL');
  });
});

describe('WebhookChannel', () => {
  it('POSTs the notification as JSON with the right headers', async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const ch = new WebhookChannel({ url: 'https://hook.example/notify', headers: { authorization: 'Bearer x' }, fetch: fetchMock });
    await ch.send(note());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hook.example/notify');
    expect((calls[0]?.body as Notification).kind).toBe('canary-dead');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['authorization']).toBe('Bearer x');
    expect(ch.name).toContain('hook.example');
  });

  it('throws on a non-2xx response', async () => {
    const fetchMock = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const ch = new WebhookChannel({ url: 'https://hook.example/notify', fetch: fetchMock });
    await expect(ch.send(note())).rejects.toThrow(/HTTP 500/);
  });
});

describe('dispatch', () => {
  it('delivers to every channel and isolates per-channel failures', async () => {
    const delivered: string[] = [];
    const good: NotificationChannel = { name: 'good', send: (n) => void delivered.push(n.kind) };
    const bad: NotificationChannel = {
      name: 'bad',
      send: () => {
        throw new Error('boom');
      },
    };

    const results = await dispatch([note(), note({ kind: 'clause-drop' })], [bad, good]);

    // both notifications reached the good channel despite the bad one throwing
    expect(delivered).toEqual(['canary-dead', 'clause-drop']);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const failures = results.filter((r) => !r.ok);
    expect(failures).toHaveLength(2);
    expect(failures[0]?.error).toBe('boom');
  });
});
