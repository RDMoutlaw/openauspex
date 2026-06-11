import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event, EventTemplate } from 'nostr-tools';

export interface Signed {
  event: Event;
  sk: Uint8Array;
  pk: string;
}

/** Finalize (sign) an event template, returning the event and its key material. */
export function sign(template: EventTemplate, sk: Uint8Array = generateSecretKey()): Signed {
  return { event: finalizeEvent(template, sk), sk, pk: getPublicKey(sk) };
}
