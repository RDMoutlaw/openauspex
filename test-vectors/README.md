# Reference test vectors

`vectors.json` is a self-contained reference for implementers: a Canary Definition (kind 32772) and a
**3-period attestation chain** (kind 1772), each attestation anchored to a **real Bitcoin mainnet
block**.

## Contents

| Field | Meaning |
|---|---|
| `secretKeyHex` | The fixed **test-only** signing key (never use a constant key in production). |
| `pubkey` | Public key derived from it. |
| `blocks` | The real mainnet blocks (`height`, `hash`, `timestamp`) the attestations anchor to. |
| `definition` | The signed kind-32772 event. |
| `attestations` | Three signed kind-1772 events, one per `block`, ~30 days apart. |
| `now` | A fixed evaluation time (1 day after the last anchor). |
| `expected` | The evaluation a monitor should produce at `now` (`alive`, 1/1 fresh signer). |
| `otsPending` | Pending OTS proofs, only if generated with `--ots` (see below). |

Because the block data is embedded, the anchors verify **offline**: build a `BitcoinProvider` from
`blocks` and the chain validates and evaluates deterministically. `packages/monitor/test/vectors.test.ts`
does exactly this. A `LIVE_BITCOIN_TESTS=1` run additionally re-checks the embedded hashes against
live mainnet.

## Regenerating

```sh
npm run vectors:generate          # anchors only (committed form)
npm run vectors:generate -- --ots # also stamp each attestation via OpenTimestamps
```

## OpenTimestamps note

A NIP-03 kind-1040 proof must carry a **complete** Bitcoin attestation, which only exists once the
OTS calendar aggregation is confirmed on-chain (~an hour or more after stamping). The committed
vectors therefore cover the **not-earlier-than** bound (block anchors) deterministically; the
**not-later-than** bound (OTS) is reproduced by running with `--ots` and upgrading the pending
proofs later via the publisher's `upgrade` step. This two-phase timing is intrinsic to OTS, not a
limitation of the vectors.
