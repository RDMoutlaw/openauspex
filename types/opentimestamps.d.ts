/**
 * Minimal ambient typings for the (untyped) `opentimestamps` npm package — only the surface this
 * project uses. The runtime module is CommonJS; we import it as a default (`export =`) namespace.
 *
 * Lives in the shared `types/` dir (referenced by every package's tsconfig) so that any package
 * importing `@openauspex/core` — which transitively imports `opentimestamps` — can resolve it
 * during typecheck.
 */
declare module 'opentimestamps' {
  namespace OpenTimestamps {
    namespace Ops {
      class OpSHA256 {
        constructor();
      }
    }

    namespace Notary {
      class TimeAttestation {}
      class BitcoinBlockHeaderAttestation extends TimeAttestation {
        height: number;
      }
    }

    class Timestamp {
      allAttestations(): Map<unknown, Notary.TimeAttestation>;
    }

    class DetachedTimestampFile {
      timestamp: Timestamp;
      static fromHash(op: Ops.OpSHA256, hash: Uint8Array): DetachedTimestampFile;
      static deserialize(bytes: Uint8Array): DetachedTimestampFile;
      serializeToBytes(): Uint8Array;
    }

    /** Submit the detached file's digest to the calendar servers (network). */
    function stamp(detached: DetachedTimestampFile): Promise<void>;

    /** Upgrade pending calendar attestations to a complete Bitcoin attestation. Returns whether it changed. */
    function upgrade(detached: DetachedTimestampFile): Promise<boolean>;

    /**
     * Verify the proof against the original digest. Return shape varies across versions
     * (a bare unix-time number, or `{ bitcoin: { timestamp, height } }`), so callers parse it
     * defensively.
     */
    function verify(
      detachedOts: DetachedTimestampFile,
      detachedOriginal: DetachedTimestampFile,
      options?: { ignoreBitcoinNode?: boolean; timeout?: number },
    ): Promise<unknown>;

    /** Human-readable description of a proof's structure. */
    function info(detached: DetachedTimestampFile): string;
  }

  export = OpenTimestamps;
}
