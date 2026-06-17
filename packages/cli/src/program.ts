import { existsSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import {
  KINDS,
  MempoolProvider,
  MultiProvider,
  isOtsComplete,
  otsInfo,
  parseAttestation,
  parseDefinition,
  parseOtsAttestation,
  verifyProof,
} from '@openauspex/core';
import type { NostrEvent } from '@openauspex/core';
import { FileStore, Publisher, simplePoolPublisher } from '@openauspex/publisher';
import type { PublishResult } from '@openauspex/publisher';
import { Monitor, fetchCanaryEvents, formatReport } from '@openauspex/monitor';
import type { MonitorReport } from '@openauspex/monitor';
import { ConsoleChannel, FileNotifyStore, WebhookChannel, decide, decideReminder, dispatch } from '@openauspex/notify';
import type { NotificationChannel } from '@openauspex/notify';

import { SAMPLE_CONFIG, loadConfig, resolveSecretKey } from './config.js';
import type { CanaryConfig, ChannelConfig } from './config.js';

interface CommonOpts {
  config: string;
  nsec?: string;
}

function buildPublisher(opts: CommonOpts): { cfg: CanaryConfig; publisher: Publisher; pool: SimplePool } {
  const cfg = loadConfig(opts.config);
  const secretKey = resolveSecretKey(opts.nsec);
  const provider = new MultiProvider(
    cfg.explorers.map((baseUrl) => new MempoolProvider({ baseUrl })),
    { quorum: 1 },
  );
  const pool = new SimplePool();
  const publisher = new Publisher({
    secretKey,
    relays: cfg.relays,
    definitionPubkey: cfg.definitionPubkey,
    provider,
    publish: simplePoolPublisher(pool),
    store: new FileStore(cfg.storePath),
  });
  return { cfg, publisher, pool };
}

function splitIds(value: string): string[] {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function printPublish(results: PublishResult[]): void {
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK ' : 'ERR'} ${r.relay}${r.error ? ` — ${r.error}` : ''}`);
  }
}

async function resolveAffirms(
  o: { affirm?: string; drop?: string },
  cfg: CanaryConfig,
  pool: SimplePool,
  signerPubkey: string,
): Promise<string[]> {
  if (o.affirm) return splitIds(o.affirm);
  const drop = new Set(o.drop ? splitIds(o.drop) : []);

  // Prefer the definition from the local config — no relay round-trip needed.
  if (cfg.definition && cfg.definition.statements.length > 0) {
    return cfg.definition.statements.map((s) => s.id).filter((id) => !drop.has(id));
  }

  // Otherwise fetch it from relays (e.g. attesting to a canary defined elsewhere).
  const defPubkey = cfg.definitionPubkey ?? signerPubkey;
  const defEvent = await pool.get(cfg.relays, {
    kinds: [KINDS.CANARY_DEFINITION],
    authors: [defPubkey],
    '#d': [cfg.canaryId],
  });
  if (!defEvent) {
    throw new Error(
      'could not derive clauses: no `definition` in the config and none found on relays; pass --affirm to list them explicitly',
    );
  }
  return parseDefinition(defEvent)
    .statements.map((s) => s.id)
    .filter((id) => !drop.has(id));
}

function resolveDefinitionPubkey(o: { pubkey?: string }, cfg: CanaryConfig): string {
  const pk = o.pubkey ?? cfg.definitionPubkey;
  if (pk) return pk;
  // Fall back to the configured signer — i.e. inspecting/checking your own canary.
  try {
    return getPublicKey(resolveSecretKey());
  } catch {
    throw new Error('need a definition pubkey: pass --pubkey, set definitionPubkey in the config, or set CANARY_NSEC');
  }
}

function buildMonitor(o: { config: string; pubkey?: string }): {
  cfg: CanaryConfig;
  monitor: Monitor;
  pool: SimplePool;
} {
  const cfg = loadConfig(o.config);
  const definitionPubkey = resolveDefinitionPubkey(o, cfg);
  // Majority cross-check across explorers (the trustless freshness check).
  const provider = new MultiProvider(cfg.explorers.map((baseUrl) => new MempoolProvider({ baseUrl })));
  const pool = new SimplePool();
  const monitor = new Monitor({
    relays: cfg.relays,
    definitionPubkey,
    canaryId: cfg.canaryId,
    provider,
    pool,
    verifyOts: verifyProof,
  });
  return { cfg, monitor, pool };
}

const DEFAULT_NOTIFY_STATE_PATH = '.openauspex/notify-state.json';

/** Build delivery channels from config, plus an optional ad-hoc webhook from a CLI flag. */
function buildChannels(channelCfgs: ChannelConfig[] | undefined, extraWebhook?: string): NotificationChannel[] {
  const cfgs = channelCfgs && channelCfgs.length > 0 ? channelCfgs : [{ type: 'console' as const }];
  const channels: NotificationChannel[] = [];
  for (const c of cfgs) {
    if (c.type === 'webhook') channels.push(new WebhookChannel({ url: c.url, headers: c.headers }));
    else channels.push(new ConsoleChannel());
  }
  if (extraWebhook) channels.push(new WebhookChannel({ url: extraWebhook }));
  return channels;
}

function notifyStatePath(o: { state?: string }, cfg: CanaryConfig): string {
  return o.state ?? cfg.notifyStatePath ?? DEFAULT_NOTIFY_STATE_PATH;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name('auspex').description('Publish and monitor Nostr warrant canaries.');

  program
    .command('keygen')
    .description('Generate a new Nostr keypair')
    .action(() => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      console.log('nsec:', nip19.nsecEncode(sk));
      console.log('npub:', nip19.npubEncode(pk));
      console.log('hex: ', pk);
    });

  program
    .command('init')
    .description('Write a starter canary.config.json')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .action((o: { config: string }) => {
      if (existsSync(o.config)) {
        console.error(`${o.config} already exists; not overwriting`);
        process.exit(1);
      }
      writeFileSync(o.config, JSON.stringify(SAMPLE_CONFIG, null, 2));
      console.log(`wrote ${o.config} — edit it, then run \`define\` and \`attest\``);
    });

  program
    .command('define')
    .description('Publish the Canary Definition from the config')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--nsec <nsec>', 'signer secret key (overrides env)')
    .action(async (o: CommonOpts) => {
      const { cfg, publisher, pool } = buildPublisher(o);
      if (!cfg.definition) throw new Error('config has no `definition` block');
      const { event, publish } = await publisher.publishDefinition({ id: cfg.canaryId, ...cfg.definition });
      console.log('published definition', event.id);
      printPublish(publish);
      pool.close(cfg.relays);
    });

  program
    .command('attest')
    .description('Compose, sign, publish, and timestamp a canary attestation')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--nsec <nsec>', 'signer secret key (overrides env)')
    .option('--affirm <ids>', 'comma-separated clause ids to affirm (default: all from the definition)')
    .option('--drop <ids>', 'comma-separated clause ids to DROP from the full set (the signal)')
    .option('--no-stamp', 'skip OpenTimestamps stamping')
    .action(async (o: CommonOpts & { affirm?: string; drop?: string; stamp: boolean }) => {
      const { cfg, publisher, pool } = buildPublisher(o);
      const affirms = await resolveAffirms(o, cfg, pool, publisher.pubkey);
      const res = await publisher.attest({ canaryId: cfg.canaryId, affirms, stamp: o.stamp });
      console.log('published attestation', res.event.id, `(anchored block ${res.anchor.height})`);
      printPublish(res.publish);
      if (res.stamped) console.log('stamped — run `auspex upgrade` later to publish the OTS proof');
      pool.close(cfg.relays);
    });

  program
    .command('upgrade')
    .description('Upgrade pending OpenTimestamps proofs and publish kind-1040 attestations')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--nsec <nsec>', 'signer secret key (overrides env)')
    .action(async (o: CommonOpts) => {
      const { cfg, publisher, pool } = buildPublisher(o);
      const reports = await publisher.upgradePending();
      if (reports.length === 0) console.log('no pending stamps');
      for (const r of reports) {
        const state = r.published ? 'published kind-1040' : r.complete ? 'complete' : 'still pending';
        console.log(`${r.eventId}: ${state}`);
      }
      pool.close(cfg.relays);
    });

  program
    .command('status')
    .description('Show local pending stamps and a config summary')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .action((o: { config: string }) => {
      const cfg = loadConfig(o.config);
      const pending = new FileStore(cfg.storePath).list();
      console.log(`canary: ${cfg.canaryId}`);
      console.log(`relays: ${cfg.relays.join(', ') || '(none)'}`);
      console.log(`pending stamps: ${pending.length}`);
      for (const s of pending) {
        console.log(`  ${s.eventId} — ${s.resolvedAt ? 'resolved' : 'awaiting confirmation'}`);
      }
    });

  program
    .command('check')
    .description('Fetch and evaluate a canary once')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--pubkey <hex>', 'definition author pubkey (overrides config)')
    .action(async (o: { config: string; pubkey?: string }) => {
      const { cfg, monitor, pool } = buildMonitor(o);
      console.log(formatReport(await monitor.check()));
      pool.close(cfg.relays);
    });

  program
    .command('watch')
    .description('Continuously monitor a canary and print status + alarms')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--pubkey <hex>', 'definition author pubkey (overrides config)')
    .option('--interval <seconds>', 'poll interval in seconds', '60')
    .action((o: { config: string; pubkey?: string; interval: string }) => {
      const { cfg, monitor, pool } = buildMonitor(o);
      const handle = monitor.watch((r: MonitorReport) => console.log(`${formatReport(r)}\n`), {
        intervalMs: Number(o.interval) * 1000,
      });
      process.on('SIGINT', () => {
        handle.stop();
        pool.close(cfg.relays);
        process.exit(0);
      });
    });

  program
    .command('inspect')
    .description("Dump a canary's raw events from the relays (definition, attestations, OTS proofs)")
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--pubkey <hex>', 'definition author pubkey (overrides config)')
    .option('--json', 'print full raw JSON events instead of a summary')
    .action(async (o: { config: string; pubkey?: string; json?: boolean }) => {
      const cfg = loadConfig(o.config);
      const definitionPubkey = resolveDefinitionPubkey(o, cfg);
      const pool = new SimplePool();
      try {
        const { definition, attestations, otsEvents } = await fetchCanaryEvents(
          pool,
          cfg.relays,
          definitionPubkey,
          cfg.canaryId,
        );

        if (o.json) {
          console.log(JSON.stringify({ definition, attestations, otsEvents }, null, 2));
          return;
        }

        const njump = (e: NostrEvent): string =>
          `https://njump.me/${nip19.neventEncode({ id: e.id, relays: cfg.relays, author: e.pubkey })}`;

        console.log(`canary "${cfg.canaryId}" — author ${definitionPubkey.slice(0, 12)}…\n`);

        if (!definition) {
          console.log('definition: NOT FOUND on relays');
        } else {
          const d = parseDefinition(definition);
          console.log(`definition (kind ${definition.kind}) ${definition.id.slice(0, 12)}…`);
          console.log(`  ${njump(definition)}`);
          console.log(`  cadence ${d.cadence}s · grace ${d.grace}s · clauses: ${d.statements.map((s) => s.id).join(', ')}`);
        }

        console.log(`\nattestations (${attestations.length}):`);
        for (const e of [...attestations].sort((a, b) => b.created_at - a.created_at)) {
          const a = parseAttestation(e);
          console.log(
            `  ${e.id.slice(0, 12)}…  block ${a.anchor?.height ?? '—'}  ${a.status}  affirms: ${a.affirms.join(', ') || '(none)'}`,
          );
          console.log(`    ${njump(e)}`);
        }

        const otsNote = otsEvents.length ? ':' : ': none yet (run `upgrade` once the OTS proof is Bitcoin-confirmed)';
        console.log(`\nOTS proofs (${otsEvents.length})${otsNote}`);
        for (const e of otsEvents) {
          const p = parseOtsAttestation(e);
          console.log(`  ${e.id.slice(0, 12)}… → timestamps ${p.targetId.slice(0, 12)}…`);
        }
      } finally {
        pool.close(cfg.relays);
      }
    });

  program
    .command('verify')
    .description("Verify an attestation's OpenTimestamps proof against Bitcoin")
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--pubkey <hex>', 'definition author pubkey (overrides config)')
    .option('--att <id>', 'attestation event id to verify (default: the latest)')
    .option('--tree', 'print the proof structure (the Merkle path to Bitcoin)')
    .option('--out <path>', 'write the .ots proof to a file')
    .action(async (o: { config: string; pubkey?: string; att?: string; tree?: boolean; out?: string }) => {
      const cfg = loadConfig(o.config);
      const definitionPubkey = resolveDefinitionPubkey(o, cfg);
      const pool = new SimplePool();
      try {
        const { attestations, otsEvents } = await fetchCanaryEvents(pool, cfg.relays, definitionPubkey, cfg.canaryId);
        const target = o.att
          ? attestations.find((e) => e.id === o.att)
          : [...attestations].sort((a, b) => b.created_at - a.created_at)[0];
        if (!target) throw new Error(o.att ? `attestation ${o.att} not found on relays` : 'no attestations found');

        const proofEvent = otsEvents.map(parseOtsAttestation).find((p) => p.targetId === target.id);
        if (!proofEvent) {
          console.log(`attestation ${target.id.slice(0, 12)}… has no OTS proof yet — run \`upgrade\` after Bitcoin confirmation`);
          return;
        }

        if (o.out) {
          writeFileSync(o.out, proofEvent.proof);
          console.log(`wrote ${o.out} (${proofEvent.proof.length} bytes)`);
        }

        console.log(`attestation ${target.id.slice(0, 12)}…`);
        if (o.tree) console.log(`\n${otsInfo(proofEvent.proof)}`);

        const result = await verifyProof(proofEvent.proof, target.id);
        if (result.complete) {
          const when = new Date((result.bitcoinTime ?? 0) * 1000).toISOString();
          console.log(`  VERIFIED — Bitcoin block ${result.height ?? '?'}, mined ${when}`);
        } else {
          console.log('  not yet confirmed in Bitcoin');
        }
        const selfContained = isOtsComplete(proofEvent.proof);
        console.log(
          `  self-contained: ${selfContained ? 'yes' : 'no (pending-form — re-run `upgrade` after 6 confirmations for a standalone proof)'}`,
        );
      } finally {
        pool.close(cfg.relays);
      }
    });

  program
    .command('notify')
    .description('Check a canary and alert on state changes + alarms (de-duplicated; cron-friendly)')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--pubkey <hex>', 'definition author pubkey (overrides config)')
    .option('--webhook <url>', 'also POST notifications to this webhook URL')
    .option('--state <path>', 'notifier state file (default .openauspex/notify-state.json)')
    .option('--interval <seconds>', 'poll continuously every N seconds instead of once')
    .action(async (o: { config: string; pubkey?: string; webhook?: string; state?: string; interval?: string }) => {
      const { cfg, monitor, pool } = buildMonitor(o);
      const store = new FileNotifyStore(notifyStatePath(o, cfg));
      const channels = buildChannels(cfg.alerts?.channels, o.webhook);

      const runOnce = async (): Promise<void> => {
        const report = await monitor.check();
        const now = Math.floor(Date.now() / 1000);
        const { notifications, state } = decide(report, store.get(cfg.canaryId), {
          now,
          confirmations: cfg.alerts?.confirmations,
          notifyOnRecovery: cfg.alerts?.notifyOnRecovery,
        });
        store.set(cfg.canaryId, state);
        if (notifications.length === 0) {
          console.log(`${cfg.canaryId}: ${report.evaluation.state} — no new notifications`);
        } else {
          await dispatch(notifications, channels);
        }
      };

      if (o.interval) {
        let stopped = false;
        const tick = async (): Promise<void> => {
          if (stopped) return;
          try {
            await runOnce();
          } catch (e) {
            console.error((e as Error).message);
          }
        };
        await tick();
        const timer = setInterval(() => void tick(), Number(o.interval) * 1000);
        process.on('SIGINT', () => {
          stopped = true;
          clearInterval(timer);
          pool.close(cfg.relays);
          process.exit(0);
        });
      } else {
        try {
          await runOnce();
        } finally {
          pool.close(cfg.relays);
        }
      }
    });

  program
    .command('remind')
    .description('Remind the operator to re-attest before the canary lapses (cron-friendly)')
    .option('-c, --config <path>', 'config file path', 'canary.config.json')
    .option('--pubkey <hex>', 'definition author pubkey (overrides config)')
    .option('--lead <seconds>', 'override reminder lead time(s); comma-separated for multiple')
    .option('--webhook <url>', 'also POST the reminder to this webhook URL')
    .option('--state <path>', 'notifier state file (default .openauspex/notify-state.json)')
    .action(async (o: { config: string; pubkey?: string; lead?: string; webhook?: string; state?: string }) => {
      const { cfg, monitor, pool } = buildMonitor(o);
      try {
        const store = new FileNotifyStore(notifyStatePath(o, cfg));
        const channels = buildChannels(cfg.reminders?.channels, o.webhook);
        const report = await monitor.check();
        const now = Math.floor(Date.now() / 1000);
        const leadTimes = o.lead
          ? splitIds(o.lead)
              .map(Number)
              .filter((n) => Number.isFinite(n) && n > 0)
          : cfg.reminders?.leadTimes;
        const { notifications, state } = decideReminder(report, store.get(cfg.canaryId), { now, leadTimes });
        store.set(cfg.canaryId, state);
        if (notifications.length === 0) {
          const dl = report.evaluation.deadline;
          console.log(
            dl !== undefined
              ? `${cfg.canaryId}: next deadline ${new Date(dl * 1000).toISOString()} — nothing due`
              : `${cfg.canaryId}: no attestation deadline (state ${report.evaluation.state})`,
          );
        } else {
          await dispatch(notifications, channels);
        }
      } finally {
        pool.close(cfg.relays);
      }
    });

  return program;
}
