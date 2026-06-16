import {
  evaluate,
  parseAttestation,
  parseDefinition,
  parseOtsAttestation,
  validateAttestation,
  verifyAnchor,
} from '@openauspex/core';
import type {
  BitcoinProvider,
  CanaryDefinition,
  EvaluatedAttestation,
  Evaluation,
  NostrEvent,
  OtsVerification,
  ValidationIssue,
} from '@openauspex/core';

export interface AttestationIssues {
  eventId: string;
  issues: ValidationIssue[];
}

export interface MonitorReport {
  definition: CanaryDefinition;
  evaluation: Evaluation;
  attestations: EvaluatedAttestation[];
  /** Attestations that failed validation (error-level issues), with details. */
  issues: AttestationIssues[];
}

export interface AssessOptions {
  provider: BitcoinProvider;
  /** Monitor's current time (unix seconds). */
  now: number;
  /** kind-1040 events seen for these attestations, for OTS (not-later-than) verification. */
  otsEvents?: NostrEvent[];
  verifyOts?: (proof: Uint8Array, eventId: string) => Promise<OtsVerification>;
  /** A prior definition version, to surface drift. */
  previousDefinition?: CanaryDefinition;
}

/**
 * Validate a canary's attestations against its definition and the Bitcoin chain, then evaluate
 * liveness and clause state. Pure aside from the injected {@link BitcoinProvider} / OTS verifier.
 */
export async function assess(
  definitionEvent: NostrEvent,
  attestationEvents: NostrEvent[],
  opts: AssessOptions,
): Promise<MonitorReport> {
  const definition = parseDefinition(definitionEvent);

  const otsByTarget = new Map<string, Uint8Array>();
  for (const e of opts.otsEvents ?? []) {
    try {
      const parsed = parseOtsAttestation(e);
      otsByTarget.set(parsed.targetId, parsed.proof);
    } catch {
      // skip malformed OTS events
    }
  }

  const evaluated: EvaluatedAttestation[] = [];
  const issues: AttestationIssues[] = [];

  for (const event of attestationEvents) {
    const result = validateAttestation(event, { definition });
    const collected = [...result.issues];
    let valid = result.valid;

    const att = parseAttestation(event);
    let anchorTime = event.created_at;

    if (att.anchor) {
      const verification = await verifyAnchor(att.anchor, opts.provider);
      if (verification.authentic && verification.block) {
        anchorTime = verification.block.timestamp; // trusted lower bound on signing time
      } else {
        valid = false;
        collected.push({
          code: 'anchor-unauthentic',
          message: verification.reason ?? 'block anchor is not authentic',
          severity: 'error',
        });
      }
    } else {
      collected.push({
        code: 'no-anchor',
        message: 'no bitcoin anchor; timing falls back to untrusted created_at',
        severity: 'warn',
      });
    }

    let otsTime: number | undefined;
    if (definition.freshness.ots && opts.verifyOts) {
      const proof = otsByTarget.get(event.id);
      if (!proof) {
        collected.push({ code: 'ots-missing', message: 'no OpenTimestamps proof seen yet', severity: 'warn' });
      } else {
        const verified = await opts.verifyOts(proof, event.id);
        if (verified.complete && verified.bitcoinTime !== undefined) {
          otsTime = verified.bitcoinTime; // trusted upper bound on signing time (not-later-than)
        } else {
          collected.push({ code: 'ots-incomplete', message: 'OTS proof not yet Bitcoin-confirmed', severity: 'warn' });
        }
      }
    }

    evaluated.push({
      eventId: event.id,
      signer: att.signer,
      status: att.status,
      affirms: att.affirms,
      anchorTime,
      otsTime,
      valid,
    });
    if (collected.some((i) => i.severity === 'error')) {
      issues.push({ eventId: event.id, issues: collected });
    }
  }

  const evaluation = evaluate(definition, evaluated, {
    now: opts.now,
    previousDefinition: opts.previousDefinition,
  });

  return { definition, evaluation, attestations: evaluated, issues };
}
