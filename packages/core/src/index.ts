/**
 * Full `@openauspex/core` surface (Node). Re-exports the browser-safe `reader` subset plus the
 * OpenTimestamps publish/verify helpers below, which pull in the Node-only `opentimestamps` library.
 * Browser/bundler consumers should import `@openauspex/core/reader` instead, to keep that dependency
 * (and its `request`/`fs`/`bitcore-lib` transitive deps) out of the bundle — see `reader.ts`.
 */
export * from './reader.js';

// OpenTimestamps stamping/verification — depends on the Node `opentimestamps` package, so it is
// intentionally kept out of the `reader` entry point. The browser-safe upper-bound extractor lives in
// `ots-block.ts` (re-exported via `reader.ts`).
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
