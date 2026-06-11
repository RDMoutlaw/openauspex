# Security model

This document describes what the OpenAuspex protocol defends against, and — just as importantly —
what it does not. A canary is an honest signal, not a magic one; this errs toward stating the limits
plainly.

## Goal

Prove that each canary attestation was produced **recently and under the operator's own control**, so
that:

- an adversary who seizes the signing key cannot keep the canary "alive" with pre-signed statements, and
- a coerced operator cannot silently back-date or paper over a missed period,

while keeping the record impossible for any single party to forge or quietly erase.

## Threats and defenses

| Threat | Defense |
|---|---|
| **Pre-signing** — generate future attestations in advance, release on a schedule after a key seizure | Each attestation embeds a recent Bitcoin block `(height, hash)`. The hash is unpredictable until the block is mined, so a future attestation cannot be produced today. `verifyAnchor` confirms the hash is the real block at that height. |
| **Back-dating** — claim an attestation predates a gap | An OpenTimestamps proof commits the attestation id into a *later* Bitcoin block, fixing an upper bound on its creation time. Timing uses the **anchor block timestamp** (lower bound) and OpenTimestamps (upper bound) — never the author-controlled event timestamp. |
| **A single block explorer lies** about a hash | `MultiProvider` requires a **quorum of independent explorers** to agree on `hash@height` before accepting it. It is pluggable, so an operator can supply their own Bitcoin node for a fully trustless check. |
| **Silent deletion / relay censorship** | Attestations are regular events retained by every relay they reach; operators publish to several. OpenTimestamps makes the Bitcoin chain the final backstop for any retained copy, and monitors can re-broadcast alerts so censoring the record means censoring every watcher too. |
| **Clause-level compulsion** — forced to keep a general "all clear" while a specific order landed | Each attestation re-affirms individual clauses. A monitor compares a signer's affirmations across periods and raises **CLAUSE-DROP** when a clause that is still in the definition stops being affirmed. The operator never *states* that an order arrived — they merely stop affirming it didn't. |
| **Definition tampering** — quietly loosen the cadence, clauses, or freshness policy | A monitor raises **DEFINITION-DRIFT** on any loosening: a longer cadence, a wider grace or freshness window, a dropped OpenTimestamps requirement, a lowered signer threshold, or a removed clause. |
| **Coercion of one of several signers** | An m-of-n threshold: the canary is alive only while at least *m* distinct authorized signers are each independently fresh, which forces independent live presence. |

## Residual limitations

- **Live coerced signing is unsolved.** No canary can defeat a key holder compelled to sign truthfully
  under duress at that moment. Mitigate out of band with a pre-announced duress convention (a designated
  duress signer, or omitting a specific clause) and multi-signer attestation.
- **Explorer trust is reduced, not eliminated.** Cross-checking defeats a single lying explorer but not
  an adversary who can MITM every configured explorer at once. Run your own node for the strongest
  guarantee.
- **OpenTimestamps is asynchronous.** A proof can only be published once it carries a complete Bitcoin
  attestation (roughly an hour after stamping). Until then the upper time bound is not yet provable; a
  monitor treats a missing or incomplete proof as a warning, not a failure.
- **Event-verification caching.** The Nostr library trusts a positive verification cached on a
  locally-finalized event. Events arriving from relays are plain data and are always fully re-verified —
  the path that matters for monitoring — but do not re-validate a mutated in-memory event and expect a
  fresh check.
- **Relay retention is best-effort.** Regular events are retained but not guaranteed; durability comes
  from multi-relay publication plus the OpenTimestamps backstop.
- **Unregistered event kinds.** The canary kinds are project-chosen and not yet registered, so
  collisions with other applications are possible until they are. They are defined in one constant for a
  one-line change.

## Reporting

This is reference-quality software for an evolving convention; review the code and this threat model
before relying on it to custody a real canary. Please open an issue to report a vulnerability or a gap
in this model.
