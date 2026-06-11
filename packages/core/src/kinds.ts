/**
 * Event kinds and tag names for OpenAuspex.
 *
 * The canary kind numbers (32772, 1772) are project-chosen and not yet registered in the Nostr
 * kinds registry; they live here as the single source of truth so they can be swapped in one place
 * once real numbers are claimed. `OTS_ATTESTATION` (1040) is the assigned NIP-03 kind.
 */
export const KINDS = {
  /** Canary Definition — addressable (parameterized replaceable); NIP-01 30000–39999 band. */
  CANARY_DEFINITION: 32772,
  /** Canary Attestation — regular event (relays retain the full archive); NIP-01 1000–9999 band. */
  CANARY_ATTESTATION: 1772,
  /** OpenTimestamps attestation — NIP-03 (assigned). */
  OTS_ATTESTATION: 1040,
  /** Watcher alert — placeholder kind for the watcher-mesh alert event. */
  CANARY_ALERT: 1773,
} as const;

/** Tag names used across canary events. */
export const TAG = {
  // Definition
  D: 'd',
  TITLE: 'title',
  CADENCE: 'cadence',
  GRACE: 'grace',
  FRESHNESS: 'freshness',
  STATEMENT: 'statement',
  THRESHOLD: 'threshold',
  P: 'p',
  // Attestation
  A: 'a',
  CANARY: 'canary',
  STATUS: 'status',
  AFFIRM: 'affirm',
  // Building blocks (NIP-01 / NIP-03 / NIP-31)
  ALT: 'alt',
  E: 'e',
  K: 'k',
} as const;

/** Anchor types that may appear in a `freshness` tag. */
export const FRESHNESS = {
  BITCOIN: 'bitcoin',
  OTS: 'ots',
} as const;

/** Marker placed in the 4th position of a signer `p` tag: `["p", <pubkey>, "", "signer"]`. */
export const SIGNER_ROLE = 'signer';

/** Attestation status values. */
export const STATUS = {
  ALIVE: 'alive',
  RETIRED: 'retired',
  TERMINATED: 'terminated',
} as const;
