import { verifyEvent } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools';

import { FRESHNESS, KINDS, STATUS, TAG } from './kinds.js';
import { CanaryParseError } from './errors.js';
import { IssueCollector } from './result.js';
import { allTags, firstTag, firstTagValue, nowSeconds } from './tags.js';
import type {
  BlockAnchor,
  CanaryAttestation,
  CanaryDefinition,
  CanaryStatus,
  NostrEvent,
  ValidationResult,
} from './types.js';

const STATUSES: readonly string[] = [STATUS.ALIVE, STATUS.RETIRED, STATUS.TERMINATED];

export interface BuildAttestationParams {
  /** Pubkey of the Definition author (for the `a` tag address). */
  definitionPubkey: string;
  /** The Definition's `d` value. */
  canaryId: string;
  /** Statement ids still affirmed this period. The set is the payload. */
  affirms: string[];
  /** Bitcoin freshness anchor (required by policies that set `freshness bitcoin`). */
  anchor?: BlockAnchor;
  status?: CanaryStatus;
  statusReason?: string;
  content?: string;
  alt?: string;
  definitionRelay?: string;
  /** Defaults to the current time. */
  created_at?: number;
}

/** Build an unsigned kind-1772 Canary Attestation template. */
export function buildAttestation(params: BuildAttestationParams): EventTemplate {
  const addr = `${KINDS.CANARY_DEFINITION}:${params.definitionPubkey}:${params.canaryId}`;
  const tags: string[][] = [];
  tags.push(params.definitionRelay ? [TAG.A, addr, params.definitionRelay] : [TAG.A, addr]);
  tags.push([TAG.CANARY, params.canaryId]);

  const statusTag: string[] = [TAG.STATUS, params.status ?? STATUS.ALIVE];
  if (params.statusReason) statusTag.push(params.statusReason);
  tags.push(statusTag);

  for (const a of params.affirms) tags.push([TAG.AFFIRM, a]);
  if (params.anchor) {
    tags.push([TAG.FRESHNESS, FRESHNESS.BITCOIN, String(params.anchor.height), params.anchor.hash]);
  }
  if (params.alt) tags.push([TAG.ALT, params.alt]);

  return {
    kind: KINDS.CANARY_ATTESTATION,
    created_at: params.created_at ?? nowSeconds(),
    content: params.content ?? '',
    tags,
  };
}

/**
 * Extract a {@link CanaryAttestation} from an event. Lenient: only throws on the wrong kind.
 * Missing/malformed fields are reported by {@link validateAttestation}.
 */
export function parseAttestation(event: NostrEvent): CanaryAttestation {
  if (event.kind !== KINDS.CANARY_ATTESTATION) {
    throw new CanaryParseError(`expected kind ${KINDS.CANARY_ATTESTATION}, got ${event.kind}`);
  }

  const aTag = firstTag(event.tags, TAG.A);
  const definitionAddr = aTag?.[1] ?? '';
  const definitionRelay = aTag?.[2];

  let canaryId = firstTagValue(event.tags, TAG.CANARY) ?? '';
  if (canaryId === '' && definitionAddr !== '') {
    const parts = definitionAddr.split(':');
    if (parts.length >= 3) canaryId = parts.slice(2).join(':');
  }

  const statusTag = firstTag(event.tags, TAG.STATUS);
  const status = (statusTag?.[1] ?? STATUS.ALIVE) as CanaryStatus;
  const statusReason = statusTag?.[2];

  const affirms = allTags(event.tags, TAG.AFFIRM)
    .map((t) => t[1])
    .filter((x): x is string => x !== undefined);

  let anchor: BlockAnchor | undefined;
  const fTag = allTags(event.tags, TAG.FRESHNESS).find((t) => t[1] === FRESHNESS.BITCOIN);
  if (fTag && fTag[2] !== undefined && fTag[3] !== undefined) {
    anchor = { height: Number(fTag[2]), hash: fTag[3] };
  }

  return {
    canaryId,
    definitionAddr,
    definitionRelay,
    signer: event.pubkey,
    status,
    statusReason,
    affirms,
    anchor,
  };
}

export interface ValidateAttestationOptions {
  /**
   * The governing Definition. When supplied, cross-reference checks run: authorized signer,
   * affirm ids ⊆ statements, address match, and freshness-policy presence. Authenticating the
   * block hash against Bitcoin and verifying the OTS proof are separate (async) checks layered
   * by later milestones.
   */
  definition?: CanaryDefinition;
}

/** Validate the signature, structure, and (optionally) cross-references of an Attestation. */
export function validateAttestation(
  event: NostrEvent,
  opts: ValidateAttestationOptions = {},
): ValidationResult {
  const c = new IssueCollector();

  if (event.kind !== KINDS.CANARY_ATTESTATION) {
    c.error('wrong-kind', `expected kind ${KINDS.CANARY_ATTESTATION}, got ${event.kind}`);
    return c.result();
  }
  if (!verifyEvent(event)) c.error('bad-signature', 'event id or signature is invalid');

  let att: CanaryAttestation;
  try {
    att = parseAttestation(event);
  } catch (e) {
    c.error('unparseable', (e as Error).message);
    return c.result();
  }

  if (att.definitionAddr === '') {
    c.error('missing-a', 'attestation is missing an `a` tag binding it to a definition');
  }
  if (!STATUSES.includes(att.status)) {
    c.error('bad-status', `unknown status "${att.status}"`);
  }
  if (att.anchor) {
    if (!Number.isInteger(att.anchor.height) || att.anchor.height < 0) {
      c.error('bad-anchor-height', 'freshness block height must be a non-negative integer');
    }
    if (!/^[0-9a-f]{64}$/.test(att.anchor.hash)) {
      c.error('bad-anchor-hash', 'freshness block hash must be 64 lowercase hex chars');
    }
  }

  const def = opts.definition;
  if (def) {
    const expectedAddr = `${KINDS.CANARY_DEFINITION}:${def.pubkey}:${def.id}`;
    if (att.definitionAddr !== expectedAddr) {
      c.error('definition-mismatch', `\`a\` tag ${att.definitionAddr} does not match definition ${expectedAddr}`);
    }
    if (att.canaryId !== def.id) {
      c.error('canary-id-mismatch', `canary id "${att.canaryId}" does not match definition "${def.id}"`);
    }

    const authorized = def.signers.length > 0 ? def.signers : [def.pubkey];
    if (!authorized.includes(att.signer)) {
      c.error('unauthorized-signer', `signer ${att.signer} is not in the authorized set`);
    }

    const validIds = new Set(def.statements.map((s) => s.id));
    for (const a of att.affirms) {
      if (!validIds.has(a)) {
        c.error('unknown-affirm', `affirm "${a}" references no statement in the definition`);
      }
    }

    if (def.freshness.bitcoin && !att.anchor && att.status === STATUS.ALIVE) {
      c.error('missing-anchor', 'definition requires a bitcoin freshness anchor but the attestation has none');
    }
  }

  return c.result();
}
