import { existsSync, readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { nip19 } from 'nostr-tools';

export interface DefinitionConfig {
  title?: string;
  content: string;
  cadence: number;
  grace: number;
  freshness: { bitcoin?: { maxBlockAge: number }; ots?: boolean };
  statements: { id: string; text: string }[];
  signers?: string[];
  threshold?: number;
}

export interface CanaryConfig {
  relays: string[];
  canaryId: string;
  definitionPubkey?: string;
  explorers: string[];
  storePath: string;
  definition?: DefinitionConfig;
}

const DEFAULT_EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];

export function loadConfig(path: string): CanaryConfig {
  const raw: Record<string, unknown> = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {};
  const bitcoin = (raw.bitcoin as { explorers?: string[] } | undefined) ?? {};
  return {
    relays: (raw.relays as string[] | undefined) ?? [],
    canaryId: (raw.canaryId as string | undefined) ?? 'primary',
    definitionPubkey: raw.definitionPubkey as string | undefined,
    explorers: bitcoin.explorers ?? DEFAULT_EXPLORERS,
    storePath: (raw.storePath as string | undefined) ?? '.openauspex/pending.json',
    definition: raw.definition as DefinitionConfig | undefined,
  };
}

/** Resolve a signer secret key from an explicit value, then env (`CANARY_NSEC` / `CANARY_SECRET_KEY`). */
export function resolveSecretKey(explicit?: string): Uint8Array {
  const val = explicit ?? process.env.CANARY_NSEC ?? process.env.CANARY_SECRET_KEY;
  if (!val) {
    throw new Error('no secret key: set CANARY_NSEC or CANARY_SECRET_KEY, or pass --nsec');
  }
  if (val.startsWith('nsec')) {
    const decoded = nip19.decode(val);
    if (decoded.type !== 'nsec') throw new Error('invalid nsec');
    return decoded.data;
  }
  if (!/^[0-9a-f]{64}$/.test(val)) throw new Error('secret key must be an nsec or 64 hex chars');
  return new Uint8Array(Buffer.from(val, 'hex'));
}

export const SAMPLE_CONFIG = {
  relays: ['wss://relay.damus.io', 'wss://nos.lol'],
  canaryId: 'primary',
  storePath: '.openauspex/pending.json',
  bitcoin: { explorers: DEFAULT_EXPLORERS },
  definition: {
    title: 'Example — Primary Canary',
    content: 'Example warrant canary. Absence or clause-drop is the message.',
    cadence: 2592000,
    grace: 604800,
    freshness: { bitcoin: { maxBlockAge: 6 }, ots: true },
    statements: [
      { id: 'no-secret-order', text: 'We have not received any secret government order, NSL, or gag-bound process.' },
      { id: 'no-backdoor', text: 'We have not installed any backdoor or weakened encryption at government request.' },
      { id: 'keys-undisclosed', text: 'We have not disclosed private keys or auth material to any third party.' },
    ],
  },
};
