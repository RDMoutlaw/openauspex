import type { CanaryDefinition, CanaryStatus } from './types.js';

/** The derived state of a canary as seen by a monitor. */
export type CanaryState = 'alive' | 'dead' | 'retired' | 'terminated' | 'unknown';

export type AlarmKind = 'dead' | 'clause-drop' | 'definition-drift';

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
  /** True iff every per-attestation check passed. Invalid attestations are ignored for liveness. */
  valid: boolean;
}

export interface EvaluateOptions {
  /** The monitor's current time (unix seconds). */
  now: number;
  /** A prior version of the definition, to surface definition drift. */
  previousDefinition?: CanaryDefinition;
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
