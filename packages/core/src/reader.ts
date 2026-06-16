/**
 * Browser-safe subset of `@openauspex/core` — everything a Nostr canary *watcher* needs to read and
 * evaluate canaries client-side, with **no Node dependencies**. Imported via `@openauspex/core/reader`.
 *
 * It deliberately excludes the OpenTimestamps publish/verify helpers (`stampEventId`, `verifyProof`,
 * …) from `ots.ts`, which pull in the Node-only `opentimestamps` library (`request`/`fs`/`bitcore-lib`)
 * and do not bundle for the browser. In their place, {@link extractBitcoinAttestation} /
 * {@link otsTimeFromProof} recover the OTS upper bound (not-later-than) directly from the proof bytes
 * plus a block-explorer lookup. The full Node surface (`@openauspex/core`) re-exports everything here.
 */
export { KINDS, TAG, FRESHNESS, STATUS, SIGNER_ROLE } from './kinds.js';
export { CanaryParseError } from './errors.js';

export type {
  NostrEvent,
  Statement,
  FreshnessPolicy,
  CanaryDefinition,
  BlockAnchor,
  CanaryStatus,
  CanaryAttestation,
  Severity,
  ValidationIssue,
  ValidationResult,
} from './types.js';

export { buildDefinition, parseDefinition, validateDefinition } from './definition.js';
export type { BuildDefinitionParams } from './definition.js';

export { buildAttestation, parseAttestation, validateAttestation } from './attestation.js';
export type { BuildAttestationParams, ValidateAttestationOptions } from './attestation.js';

export { getBlockByHeight } from './bitcoin/provider.js';
export type { BitcoinProvider, BlockInfo } from './bitcoin/provider.js';
export { defaultFetch } from './bitcoin/http.js';
export type { FetchLike, HttpResponse } from './bitcoin/http.js';
export { MempoolProvider } from './bitcoin/mempool.js';
export type { MempoolProviderOptions } from './bitcoin/mempool.js';
export { MultiProvider } from './bitcoin/multi.js';
export type { MultiProviderOptions } from './bitcoin/multi.js';

export {
  SECONDS_PER_BLOCK,
  verifyAnchor,
  blockWindowToSeconds,
  checkBlockRecency,
  checkRecency,
} from './freshness.js';
export type { AnchorVerification, BlockRecency, RecencyCheck } from './freshness.js';

export { evaluate, diffDefinitions, DEFAULT_MAX_OTS_STRADDLE } from './evaluate.js';
export type {
  CanaryState,
  AlarmKind,
  Alarm,
  EvaluatedAttestation,
  EvaluateOptions,
  Evaluation,
} from './evaluate.js';

export {
  extractBitcoinAttestation,
  verifyOtsBitcoin,
  otsTimeFromProof,
  OtsParseError,
  OtsVerificationError,
} from './ots-block.js';
export type { BitcoinAttestation, OtsVerifyResult } from './ots-block.js';
