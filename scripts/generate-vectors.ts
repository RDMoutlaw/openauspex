/**
 * Generate reference test vectors: a Canary Definition + a 3-period attestation chain anchored to
 * REAL mainnet blocks (fetched live from mempool.space). The block data is embedded so the vectors
 * verify offline. Run: `npm run vectors:generate` (add `--ots` to also stamp each attestation).
 *
 * The signing key is fixed and TEST-ONLY, so re-running produces identical vectors (block data for
 * the fixed historical heights never changes).
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import {
  buildAttestation,
  buildDefinition,
  getBlockByHeight,
  MempoolProvider,
  stampEventId,
} from '@openauspex/core';

const SK = new Uint8Array(32).fill(7); // TEST ONLY — never use a constant key in production
const HEIGHTS = [840000, 844320, 848640]; // ~30 days apart, all historical mainnet blocks
const CADENCE = 30 * 86400;
const GRACE = 7 * 86400;
const STATEMENTS = [
  { id: 'no-secret-order', text: 'We have not received any secret government order, NSL, or gag-bound process.' },
  { id: 'no-backdoor', text: 'We have not installed any backdoor or weakened encryption at government request.' },
  { id: 'keys-undisclosed', text: 'We have not disclosed private keys or auth material to any third party.' },
];

const WANT_OTS = process.argv.includes('--ots');

async function main(): Promise<void> {
  const pk = getPublicKey(SK);
  const provider = new MempoolProvider();

  const blocks = [];
  for (const height of HEIGHTS) blocks.push(await getBlockByHeight(provider, height));

  const definition = finalizeEvent(
    buildDefinition({
      id: 'primary',
      title: 'Reference — Primary Canary',
      content: 'Reference warrant canary test vector. Absence or clause-drop is the message.',
      cadence: CADENCE,
      grace: GRACE,
      freshness: { bitcoin: { maxBlockAge: 6 }, ots: true },
      statements: STATEMENTS,
      created_at: blocks[0].timestamp - 600,
    }),
    SK,
  );

  const affirms = STATEMENTS.map((s) => s.id);
  const attestations = [];
  const otsPending: { targetId: string; proofBase64: string }[] = [];
  for (const block of blocks) {
    const att = finalizeEvent(
      buildAttestation({
        definitionPubkey: pk,
        canaryId: 'primary',
        affirms,
        anchor: { height: block.height, hash: block.hash },
        created_at: block.timestamp + 60,
        alt: 'Warrant canary attestation — all clauses affirmed.',
      }),
      SK,
    );
    attestations.push(att);
    if (WANT_OTS) {
      const proof = await stampEventId(att.id);
      otsPending.push({ targetId: att.id, proofBase64: Buffer.from(proof).toString('base64') });
    }
  }

  const now = blocks[blocks.length - 1].timestamp + 86400;
  const vectors = {
    description:
      'Reference OpenAuspex vectors: a Canary Definition (kind 32772) and a 3-period ' +
      'attestation chain (kind 1772) anchored to real mainnet blocks.',
    note:
      'secretKeyHex is TEST ONLY. `blocks` are real mainnet blocks — build an offline provider ' +
      'from them to verify the anchors. Any `otsPending` proofs are pending until Bitcoin-confirmed.',
    secretKeyHex: Buffer.from(SK).toString('hex'),
    pubkey: pk,
    now,
    expected: { state: 'alive', threshold: 1, freshSigners: 1 },
    blocks,
    definition,
    attestations,
    otsPending,
  };

  mkdirSync('test-vectors', { recursive: true });
  writeFileSync('test-vectors/vectors.json', `${JSON.stringify(vectors, null, 2)}\n`);
  console.log(
    `wrote test-vectors/vectors.json — ${attestations.length} attestations anchored to blocks ` +
      `${HEIGHTS.join(', ')}; OTS: ${WANT_OTS ? otsPending.length + ' pending' : 'none'}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
