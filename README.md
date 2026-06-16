# OpenAuspex

A warrant canary system for [Nostr](https://nostr.com), using **Bitcoin block-hash anchoring** and
**OpenTimestamps** to make each statement's freshness tamper-evident.

## What is a warrant canary?

A warrant canary is a routine, signed statement — *"as of this date, we have not received a secret
government order"* — whose **absence** carries the message. An operator served with a gag-bound order
can't legally say so; instead they stop renewing the statement, and watchers infer what the silence
means.

The difficult property is **freshness**: proving each statement was produced *recently, by a live
key-holder* — not pre-computed and released on a schedule. Anchoring every statement to a recent
Bitcoin block makes pre-signing impossible: next period's block hash is unknowable today, so an
adversary cannot fabricate future statements in advance. This turns a one-time key theft, or a single
coerced signing, into the need for *continuous* live access — but it does not, and cannot, defeat an
adversary who retains the key or who compels the operator to keep signing truthfully under duress (see
[SECURITY.md](./SECURITY.md)). Freshness proves recency of signing, not that the signer was free.

It ships a TypeScript library and an `auspex` CLI to **publish**, **archive**, and **monitor**
canaries.

## How it works

Three open technologies, each with a distinct job.

### Nostr — authorship, archive, and monitoring

[Nostr](https://nostr.com) is a minimal protocol for cryptographically-signed events distributed
across many independent relays. It natively provides three of the four properties a canary needs:

- **Authorship without a host** — every event is signed by the operator's key, so no relay can forge a
  statement.
- **A decentralized archive** — events replicate across many relays; no single host can quietly delete
  the record.
- **Trivial monitoring** — a statement is just an event, and anyone can subscribe to it.

Two event kinds model a canary:

- a **Canary Definition** (an addressable, replaceable event) — the contract: how often the canary
  renews, the grace window, the freshness policy, the clauses being attested, and the authorized
  signers;
- a **Canary Attestation** (a regular event, retained by relays as the permanent archive) — each
  periodic "all clear," re-affirming the clauses that still hold.

The fourth property — freshness — is what the next two technologies add.

### Bitcoin — a trusted clock (proves *not-earlier-than*)

Every attestation embeds a recent **Bitcoin block** (its height and hash):

```
["freshness", "bitcoin", "953268", "0000…132bcd"]
```

A block hash is a commitment to proof-of-work — **unpredictable until the block is mined**. Embedding
it proves the attestation was created *after* that block existed. This is what defeats pre-signing: an
adversary cannot fabricate next period's canary today, because they cannot know next period's block
hash. The signer must be present, with the key, at every interval.

A monitor verifies the embedded hash really is the canonical mainnet block at that height —
**cross-checking several independent block explorers** so no single one can lie — and uses the block's
own timestamp as the trusted clock. The author-controlled Nostr timestamp is never trusted for timing.

### OpenTimestamps — a back-dating defense (proves *not-later-than*)

[OpenTimestamps](https://opentimestamps.org) timestamps a hash into the Bitcoin chain through public
calendar servers, which batch many hashes into a single transaction. After an attestation is published,
its event id is timestamped, committing it into a *later* block — an upper bound on when it was created.
A monitor compares that bound against the attestation's Bitcoin anchor (the lower bound) and raises a
**BACK-DATED** alarm when the two straddle too wide a gap, exposing a period back-filled long after the
fact and passed off as old. The proof is carried as a companion event (NIP-03).

### The two bounds together

```
Bitcoin block 953268 ──[ attestation actually signed ]── later block (via OpenTimestamps)
   hash embedded                                            id committed
   └ can't have signed before here       can't back-date after here ┘
              the true signing time is provably inside this window
```

**Why Bitcoin rather than NTP or a randomness beacon?** The anchor must be unpredictable in advance,
publicly verifiable, and free of any trusted timestamp authority. Bitcoin block hashes satisfy all
three; NTP or a drand/NIST beacon would reintroduce a party you have to trust.

## Event kinds

| Kind | Name | Type |
|---|---|---|
| `32772` | Canary Definition | addressable (NIP-01) |
| `1772` | Canary Attestation | regular (NIP-01) |
| `1040` | OpenTimestamps attestation | NIP-03 |

The `32772` and `1772` numbers are project-chosen and not yet registered in the Nostr kinds registry;
they live in a single constant (`KINDS`) and can be changed in one place.

## Packages

| Package | Responsibility |
|---|---|
| `@openauspex/core` | Event modelling & validation, Bitcoin freshness, OpenTimestamps, and the pure evaluation engine. |
| `@openauspex/publisher` | Operator side: anchor → sign → publish, plus the OpenTimestamps upgrade lifecycle. |
| `@openauspex/monitor` | Watcher side: fetch, validate against the chain, and raise DEAD / CLAUSE-DROP / DRIFT alarms. |
| `@openauspex/cli` | The `auspex` command, wrapping the publisher and monitor. |

The `core` evaluation engine performs no I/O, so the security-critical logic is unit-tested offline.

## Install & develop

```sh
npm install
npm test            # offline; live Bitcoin/OpenTimestamps tests are env-gated
npm run typecheck
npm run build       # compile every package to dist/ (what gets published)
```

Requires Node 20+. The CLI shims a WebSocket (via `ws`) because Node < 22 has no global one and Nostr
relay connections need it; library consumers on older Node should call nostr-tools'
`useWebSocketImplementation` themselves. Optional live checks: `LIVE_BITCOIN_TESTS=1 npm test`,
`LIVE_OTS_TESTS=1 npm test`.

## Using the CLI

```sh
# keys — save the nsec somewhere safe, then export it
npm run cli -- keygen
export CANARY_NSEC=nsec1...

# scaffold and edit a config (see canary.config.example.json for the shape)
npm run cli -- init

# publish the definition, then an attestation (anchored + OpenTimestamped)
npm run cli -- define
npm run cli -- attest                  # --drop <clause>  to stop affirming one clause (the signal)

# an hour or so later, publish the OpenTimestamps proof once it is Bitcoin-confirmed
npm run cli -- upgrade

# anyone can watch or inspect it
npm run cli -- check   --pubkey <author-hex>
npm run cli -- watch   --pubkey <author-hex> --interval 300
npm run cli -- inspect --pubkey <author-hex>     # raw events + njump links (add --json)
```

The configuration is a single JSON file — see [`canary.config.example.json`](./canary.config.example.json).
For a multi-signer canary, add `signers` (authorized pubkeys) and a `threshold` to the `definition`; set
a top-level `definitionPubkey` to monitor a canary you didn't author.

## Using the library

```ts
import {
  buildDefinition, parseDefinition, validateAttestation,
  MempoolProvider, MultiProvider, verifyAnchor, evaluate,
} from '@openauspex/core';

// Cross-check the block anchor across independent explorers (no single point of trust).
const provider = new MultiProvider([
  new MempoolProvider({ baseUrl: 'https://mempool.space/api' }),
  new MempoolProvider({ baseUrl: 'https://blockstream.info/api' }),
]);

// …fetch a definition + attestations from relays, verifyAnchor each, then:
const result = evaluate(definition, evaluatedAttestations, { now: Math.floor(Date.now() / 1000) });
// → { state: 'alive' | 'dead' | 'retired' | 'unknown', alarms, freshSigners, deadline }
```

## Security

See [SECURITY.md](./SECURITY.md) for the full threat model and an honest account of what this does and
does not defend against — notably, no canary can defeat live coercion of a key holder compelled to sign
truthfully under duress.

## Reference vectors

[`test-vectors/`](./test-vectors) contains a definition and a three-period attestation chain anchored
to real mainnet blocks, with the block data embedded so the chain validates offline.

## License

MIT
