import { verifyEvent } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools';

import { FRESHNESS, KINDS, SIGNER_ROLE, TAG } from './kinds.js';
import { CanaryParseError } from './errors.js';
import { IssueCollector } from './result.js';
import { allTags, firstTagValue, nowSeconds } from './tags.js';
import type {
  CanaryDefinition,
  FreshnessPolicy,
  NostrEvent,
  Statement,
  ValidationResult,
} from './types.js';

export interface BuildDefinitionParams {
  /** `d` tag — canary identifier, unique per pubkey. */
  id: string;
  content: string;
  /** Expected seconds between attestations. */
  cadence: number;
  /** Slack added to `cadence` before the canary is declared dead, in seconds. */
  grace: number;
  freshness: FreshnessPolicy;
  statements: Statement[];
  /** Authorized signer pubkeys. Omit for a single-author canary. */
  signers?: string[];
  /** m-of-n threshold. Omit to leave it at the default of 1. */
  threshold?: number;
  title?: string;
  /** Defaults to the current time. */
  created_at?: number;
}

/** Build an unsigned kind-32772 Canary Definition template. */
export function buildDefinition(params: BuildDefinitionParams): EventTemplate {
  const tags: string[][] = [[TAG.D, params.id]];
  if (params.title) tags.push([TAG.TITLE, params.title]);
  tags.push([TAG.CADENCE, String(params.cadence)]);
  tags.push([TAG.GRACE, String(params.grace)]);
  if (params.freshness.bitcoin) {
    tags.push([TAG.FRESHNESS, FRESHNESS.BITCOIN, String(params.freshness.bitcoin.maxBlockAge)]);
  }
  if (params.freshness.ots) tags.push([TAG.FRESHNESS, FRESHNESS.OTS]);
  for (const s of params.statements) tags.push([TAG.STATEMENT, s.id, s.text]);
  if (params.threshold !== undefined) tags.push([TAG.THRESHOLD, String(params.threshold)]);
  for (const p of params.signers ?? []) tags.push([TAG.P, p, '', SIGNER_ROLE]);

  return {
    kind: KINDS.CANARY_DEFINITION,
    created_at: params.created_at ?? nowSeconds(),
    content: params.content,
    tags,
  };
}

/**
 * Extract a {@link CanaryDefinition} from an event.
 *
 * Lenient: only throws when the event is not structurally a definition at all (wrong kind, or
 * no `d` tag). Numeric problems (e.g. a missing `cadence`) surface as `NaN` and are reported by
 * {@link validateDefinition}. Always validate before using a parsed definition for monitoring.
 */
export function parseDefinition(event: NostrEvent): CanaryDefinition {
  if (event.kind !== KINDS.CANARY_DEFINITION) {
    throw new CanaryParseError(`expected kind ${KINDS.CANARY_DEFINITION}, got ${event.kind}`);
  }
  const id = firstTagValue(event.tags, TAG.D);
  if (id === undefined) throw new CanaryParseError('definition is missing a `d` tag');

  const cadenceRaw = firstTagValue(event.tags, TAG.CADENCE);
  const graceRaw = firstTagValue(event.tags, TAG.GRACE);

  const freshness: FreshnessPolicy = {};
  for (const t of allTags(event.tags, TAG.FRESHNESS)) {
    if (t[1] === FRESHNESS.BITCOIN) {
      freshness.bitcoin = { maxBlockAge: t[2] === undefined ? NaN : Number(t[2]) };
    } else if (t[1] === FRESHNESS.OTS) {
      freshness.ots = true;
    }
  }

  const statements: Statement[] = [];
  for (const t of allTags(event.tags, TAG.STATEMENT)) {
    if (t[1] !== undefined) statements.push({ id: t[1], text: t[2] ?? '' });
  }

  const signers: string[] = [];
  for (const t of allTags(event.tags, TAG.P)) {
    if (t[3] === SIGNER_ROLE && t[1] !== undefined) signers.push(t[1]);
  }

  const thresholdRaw = firstTagValue(event.tags, TAG.THRESHOLD);
  const thresholdParsed = thresholdRaw === undefined ? 1 : Number(thresholdRaw);
  const threshold = Number.isInteger(thresholdParsed) && thresholdParsed >= 1 ? thresholdParsed : 1;

  return {
    id,
    pubkey: event.pubkey,
    title: firstTagValue(event.tags, TAG.TITLE),
    content: event.content,
    cadence: cadenceRaw === undefined ? NaN : Number(cadenceRaw),
    grace: graceRaw === undefined ? NaN : Number(graceRaw),
    freshness,
    statements,
    signers,
    threshold,
  };
}

/** Validate the signature and structure of a Canary Definition. Never throws. */
export function validateDefinition(event: NostrEvent): ValidationResult {
  const c = new IssueCollector();

  if (event.kind !== KINDS.CANARY_DEFINITION) {
    c.error('wrong-kind', `expected kind ${KINDS.CANARY_DEFINITION}, got ${event.kind}`);
    return c.result();
  }
  // verifyEvent recomputes the id from the event's contents and checks the schnorr signature.
  // Note: nostr-tools caches a positive result on a hidden symbol, so it trusts a locally
  // finalized event without rechecking. Events arriving from relays are plain JSON (no symbol)
  // and are always fully verified — which is the path that matters for monitoring.
  if (!verifyEvent(event)) c.error('bad-signature', 'event id or signature is invalid');

  let def: CanaryDefinition;
  try {
    def = parseDefinition(event);
  } catch (e) {
    c.error('unparseable', (e as Error).message);
    return c.result();
  }

  if (def.id.length === 0) c.error('empty-id', '`d` tag value is empty');
  if (!Number.isInteger(def.cadence) || def.cadence <= 0) {
    c.error('bad-cadence', '`cadence` must be a positive integer (seconds)');
  }
  if (!Number.isInteger(def.grace) || def.grace < 0) {
    c.error('bad-grace', '`grace` must be a non-negative integer (seconds)');
  }
  if (!def.freshness.bitcoin && !def.freshness.ots) {
    c.warn('no-freshness', 'definition declares no freshness policy; this is only a website-grade canary');
  }
  if (def.freshness.bitcoin) {
    const n = def.freshness.bitcoin.maxBlockAge;
    if (!Number.isInteger(n) || n <= 0) {
      c.error('bad-freshness-window', 'bitcoin freshness window must be a positive integer (blocks)');
    }
  }
  if (def.statements.length === 0) {
    c.warn('no-statements', 'definition has no statements; clause-drop signalling is unavailable');
  }

  const seen = new Set<string>();
  for (const s of def.statements) {
    if (seen.has(s.id)) {
      c.error('duplicate-statement', `statement id "${s.id}" is duplicated; ids must be unique stable handles`);
    }
    seen.add(s.id);
  }

  if (def.threshold > Math.max(def.signers.length, 1)) {
    c.error('threshold-too-high', `threshold ${def.threshold} exceeds ${def.signers.length} authorized signer(s)`);
  }
  for (const p of def.signers) {
    if (!/^[0-9a-f]{64}$/.test(p)) {
      c.warn('malformed-signer', `signer pubkey "${p}" is not 64 lowercase hex chars`);
    }
  }

  return c.result();
}
