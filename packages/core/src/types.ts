import type { Event } from 'nostr-tools';

/** A signed Nostr event (alias of nostr-tools' `Event`). */
export type NostrEvent = Event;

/** A clause the canary attests. `id` is the stable handle re-asserted by attestations. */
export interface Statement {
  id: string;
  text: string;
}

/** Freshness policy declared by a Definition. */
export interface FreshnessPolicy {
  /** Require a Bitcoin block anchor mined within `maxBlockAge` blocks of signing. */
  bitcoin?: { maxBlockAge: number };
  /** Require a NIP-03 OpenTimestamps proof on each attestation. */
  ots?: boolean;
}

/** Parsed kind-32772 Canary Definition. */
export interface CanaryDefinition {
  /** `d` tag — canary identifier, unique per pubkey. */
  id: string;
  /** Author pubkey (the defining event's pubkey). */
  pubkey: string;
  title?: string;
  content: string;
  /** Expected seconds between attestations. */
  cadence: number;
  /** Slack added to `cadence` before the canary is declared dead, in seconds. */
  grace: number;
  freshness: FreshnessPolicy;
  statements: Statement[];
  /** Authorized signer pubkeys (empty ⇒ the definition author is the sole signer). */
  signers: string[];
  /** m-of-n threshold: how many distinct signers must attest each period. Defaults to 1. */
  threshold: number;
}

/** A Bitcoin block anchor embedded in an attestation. */
export interface BlockAnchor {
  height: number;
  hash: string;
}

export type CanaryStatus = 'alive' | 'retired' | 'terminated';

/** Parsed kind-1772 Canary Attestation. */
export interface CanaryAttestation {
  /** The canary identifier (from the `canary` tag, or the `a` tag's d-component). */
  canaryId: string;
  /** Full address of the governing Definition: `"32772:<pubkey>:<d>"`. */
  definitionAddr: string;
  /** Optional relay hint from the `a` tag. */
  definitionRelay?: string;
  /** Pubkey of the signer of this attestation (the event's pubkey). */
  signer: string;
  status: CanaryStatus;
  /** Reason text accompanying a `retired`/`terminated` status. */
  statusReason?: string;
  /** Statement ids re-affirmed by this attestation. The SET is the payload. */
  affirms: string[];
  /** Bitcoin freshness anchor (present when the policy requires it). */
  anchor?: BlockAnchor;
}

export type Severity = 'error' | 'warn';

export interface ValidationIssue {
  code: string;
  message: string;
  severity: Severity;
}

export interface ValidationResult {
  /** True when there are no `error`-severity issues. */
  valid: boolean;
  issues: ValidationIssue[];
}
