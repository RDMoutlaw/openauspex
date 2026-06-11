/**
 * A minimal structural subset of the Fetch API. Defining it here keeps `core` free of DOM/Node
 * type dependencies while remaining compatible with the global `fetch` in both environments and
 * trivially mockable in tests.
 */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<HttpResponse>;

/** The runtime's global `fetch`, narrowed to {@link FetchLike}. Throws if unavailable. */
export function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error('global fetch is unavailable; pass a fetchFn explicitly');
  return f;
}
