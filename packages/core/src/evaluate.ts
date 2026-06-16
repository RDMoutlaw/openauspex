import type { CanaryDefinition, CanaryStatus } from './types.js';

/** The derived state of a canary as seen by a monitor. */
export type CanaryState = 'alive' | 'dead' | 'retired' | 'terminated' | 'unknown';

export type AlarmKind = 'dead' | 'clause-drop' | 'definition-drift' | 'back-dated';

/**
 * Default maximum gap between an attestation's lower bound (its anchor block time) and its upper
 * bound (its OpenTimestamps commit time) before it is treated as back-dated. A genuine attestation
 * anchors a recent block and is stamped immediately, so the two bounds sit only an OTS confirmation
 * apart (~hours); 24h leaves generous slack for slow confirmation without admitting a back-filled
 * period.
 */
export const DEFAULT_MAX_OTS_STRADDLE = 86_400;

/** Allowance for Bitcoin's ~2h block-timestamp tolerance when comparing the two bounds. */
const TIMESTAMP_SLOP = 7_200;

export interface Alarm {
  kind: AlarmKind;
  message: string;
  /** Clause id (for clause-drop / clause removal). */
  clause?: string;
  /** Signer pubkey, when signer-specific. */
  signer?: string;
  /** Related event id, when applicable. */
  eventId?: string;
}

/**
 * A canary attestation reduced to what the (pure) evaluator needs. The monitor builds these by
 * parsing kind-1772 events and running the async checks — signature, block-anchor authenticity,
 * freshness, OTS — recording the trusted anchor block time. `created_at` is never used.
 */
export interface EvaluatedAttestation {
  eventId: string;
  signer: string;
  status: CanaryStatus;
  affirms: string[];
  /** Trusted signing-time lower bound: the anchor block's header timestamp (unix seconds). */
  anchorTime: number;
  /**
   * Trusted signing-time UPPER bound: the Bitcoin block time committing this event id via a complete
   * NIP-03 OpenTimestamps proof (unix seconds). Present only once a complete proof has been verified;
   * `undefined` while OTS is still pending. With {@link anchorTime} it brackets the true signing time
   * in `[anchorTime, otsTime]`.
   */
  otsTime?: number;
  /** True iff every per-attestation check passed. Invalid attestations are ignored for liveness. */
  valid: boolean;
}

export interface EvaluateOptions {
  /** The monitor's current time (unix seconds). */
  now: number;
  /** A prior version of the definition, to surface definition drift. */
  previousDefinition?: CanaryDefinition;
  /**
   * Maximum tolerated gap between an attestation's anchor block time and its OTS commit time before a
   * `back-dated` alarm is raised. Defaults to {@link DEFAULT_MAX_OTS_STRADDLE}.
   */
  maxOtsStraddle?: number;
}

export interface Evaluation {
  state: CanaryState;
  alarms: Alarm[];
  /** Authorized signers whose latest valid attestation is still within cadence + grace of `now`. */
  freshSigners: string[];
  /** Distinct signers required for the canary to be alive. */
  threshold: number;
  /** Trusted time of the most recent valid attestation, if any. */
  lastAttestationTime?: number;
  /** When the canary will go dead if no further attestations arrive (the threshold-th deadline). */
  deadline?: number;
}

function authorizedSigners(definition: CanaryDefinition): string[] {
  return definition.signers.length > 0 ? definition.signers : [definition.pubkey];
}

/**
 * Evaluate a canary from its definition and the attestations seen so far. Pure and deterministic:
 * all timing uses trusted anchor block times supplied on each {@link EvaluatedAttestation}.
 */
export function evaluate(
  definition: CanaryDefinition,
  attestations: EvaluatedAttestation[],
  opts: EvaluateOptions,
): Evaluation {
  const { now } = opts;
  const alarms: Alarm[] = [];
  const threshold = Math.max(1, definition.threshold);

  if (opts.previousDefinition) {
    alarms.push(...diffDefinitions(opts.previousDefinition, definition));
  }

  const authorized = authorizedSigners(definition);
  const valid = attestations
    .filter((a) => a.valid && authorized.includes(a.signer))
    .sort((x, y) => x.anchorTime - y.anchorTime);

  if (valid.length === 0) {
    return { state: 'unknown', alarms, freshSigners: [], threshold };
  }

  const latest = valid[valid.length - 1]!;

  // Clause-drop is surfaced regardless of liveness — including on a (possibly coerced) shutdown.
  alarms.push(...clauseDropAlarms(definition, valid));
  // Back-dating likewise: it flags archive tampering, not a liveness change.
  alarms.push(...backDatingAlarms(valid, opts.maxOtsStraddle ?? DEFAULT_MAX_OTS_STRADDLE));

  if (latest.status === 'retired' || latest.status === 'terminated') {
    return {
      state: latest.status,
      alarms,
      freshSigners: [],
      threshold,
      lastAttestationTime: latest.anchorTime,
    };
  }

  const cadenceGrace = definition.cadence + definition.grace;
  const latestBySigner = new Map<string, EvaluatedAttestation>();
  for (const a of valid) {
    const cur = latestBySigner.get(a.signer);
    if (!cur || a.anchorTime > cur.anchorTime) latestBySigner.set(a.signer, a);
  }

  const freshSigners: string[] = [];
  const deadlines: number[] = [];
  for (const [signer, a] of latestBySigner) {
    const deadline = a.anchorTime + cadenceGrace;
    deadlines.push(deadline);
    if (now <= deadline) freshSigners.push(signer);
  }

  // The canary is alive while at least `threshold` signers are fresh; it dies when the
  // threshold-th-largest signer deadline passes.
  const deadline = deadlines.length >= threshold
    ? [...deadlines].sort((a, b) => b - a)[threshold - 1]
    : undefined;

  let state: CanaryState;
  if (freshSigners.length >= threshold) {
    state = 'alive';
  } else {
    state = 'dead';
    alarms.push({
      kind: 'dead',
      message: `only ${freshSigners.length} of ${threshold} required signer(s) fresh within cadence ${definition.cadence}s + grace ${definition.grace}s`,
    });
  }

  return {
    state,
    alarms,
    freshSigners,
    threshold,
    lastAttestationTime: latest.anchorTime,
    deadline,
  };
}

/** Per-signer clause-drop detection: a clause affirmed before, absent now, still in the definition. */
function clauseDropAlarms(definition: CanaryDefinition, validSortedAsc: EvaluatedAttestation[]): Alarm[] {
  const out: Alarm[] = [];
  const defStatements = new Set(definition.statements.map((s) => s.id));

  const bySigner = new Map<string, EvaluatedAttestation[]>();
  for (const a of validSortedAsc) {
    const arr = bySigner.get(a.signer);
    if (arr) arr.push(a);
    else bySigner.set(a.signer, [a]);
  }

  for (const [signer, list] of bySigner) {
    if (list.length < 2) continue;
    const prev = list[list.length - 2]!;
    const latest = list[list.length - 1]!;
    const latestSet = new Set(latest.affirms);
    for (const clause of prev.affirms) {
      if (!latestSet.has(clause) && defStatements.has(clause)) {
        out.push({
          kind: 'clause-drop',
          clause,
          signer,
          eventId: latest.eventId,
          message: `signer ${signer} stopped affirming "${clause}"`,
        });
      }
    }
  }
  return out;
}

/**
 * Back-dating detection from the OpenTimestamps upper bound. The true signing time lies in
 * `[anchorTime, otsTime]`; a genuine attestation anchors a recent block and is stamped right away, so
 * that window spans only OTS confirmation latency (~hours). A window wider than `maxStraddle` means
 * the anchor predates the chain commitment by far — the hallmark of a period back-filled long after
 * the fact and passed off as old. An upper bound that precedes the lower bound (beyond timestamp
 * slop) is cryptographically inconsistent and equally suspect.
 *
 * Reported regardless of liveness. A back-dated attestation necessarily carries an old anchor, so it
 * can never sustain current liveness on its own; the value here is exposing that the archive is being
 * rewritten — exactly the back-dating that OpenTimestamps exists to catch.
 */
function backDatingAlarms(valid: EvaluatedAttestation[], maxStraddle: number): Alarm[] {
  const out: Alarm[] = [];
  for (const a of valid) {
    if (a.otsTime === undefined) continue; // OTS still pending — no upper bound to check yet
    const straddle = a.otsTime - a.anchorTime;
    if (straddle > maxStraddle) {
      out.push({
        kind: 'back-dated',
        signer: a.signer,
        eventId: a.eventId,
        message: `anchor block is ${straddle}s older than the OpenTimestamps commit (> ${maxStraddle}s); the attestation was timestamped long after its anchor, indicating a back-filled period`,
      });
    } else if (straddle < -TIMESTAMP_SLOP) {
      out.push({
        kind: 'back-dated',
        signer: a.signer,
        eventId: a.eventId,
        message: `OpenTimestamps commit precedes the anchor block by ${-straddle}s; the freshness bounds are inconsistent`,
      });
    }
  }
  return out;
}

/** Surface any loosening of a definition as yellow-flag drift alarms. */
export function diffDefinitions(prev: CanaryDefinition, next: CanaryDefinition): Alarm[] {
  const out: Alarm[] = [];
  const drift = (message: string, clause?: string): void => {
    out.push({ kind: 'definition-drift', message, ...(clause ? { clause } : {}) });
  };

  if (next.cadence > prev.cadence) drift(`cadence loosened from ${prev.cadence}s to ${next.cadence}s`);
  if (next.grace > prev.grace) drift(`grace widened from ${prev.grace}s to ${next.grace}s`);
  if (prev.freshness.bitcoin && !next.freshness.bitcoin) drift('bitcoin freshness requirement removed');
  if (
    prev.freshness.bitcoin &&
    next.freshness.bitcoin &&
    next.freshness.bitcoin.maxBlockAge > prev.freshness.bitcoin.maxBlockAge
  ) {
    drift(
      `bitcoin freshness window widened from ${prev.freshness.bitcoin.maxBlockAge} to ${next.freshness.bitcoin.maxBlockAge} blocks`,
    );
  }
  if (prev.freshness.ots && !next.freshness.ots) drift('OpenTimestamps requirement removed');
  if (next.threshold < prev.threshold) drift(`signer threshold lowered from ${prev.threshold} to ${next.threshold}`);

  const nextStatements = new Set(next.statements.map((s) => s.id));
  for (const s of prev.statements) {
    if (!nextStatements.has(s.id)) drift(`clause "${s.id}" removed from the definition`, s.id);
  }
  return out;
}
