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

export {
  stampEventId,
  upgradeProof,
  verifyProof,
  isOtsComplete,
  otsInfo,
  buildOtsAttestation,
  parseOtsAttestation,
} from './ots.js';
export type { OtsVerification, BuildOtsAttestationParams, ParsedOtsAttestation } from './ots.js';

export { evaluate, diffDefinitions } from './evaluate.js';
export type {
  CanaryState,
  AlarmKind,
  Alarm,
  EvaluatedAttestation,
  EvaluateOptions,
  Evaluation,
} from './evaluate.js';
