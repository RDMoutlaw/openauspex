/** Small helpers for reading Nostr tag arrays (`string[][]`). */

export function firstTag(tags: string[][], name: string): string[] | undefined {
  return tags.find((t) => t[0] === name);
}

export function firstTagValue(tags: string[][], name: string): string | undefined {
  return firstTag(tags, name)?.[1];
}

export function allTags(tags: string[][], name: string): string[][] {
  return tags.filter((t) => t[0] === name);
}

/** Current time in whole seconds (Nostr `created_at` units). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
