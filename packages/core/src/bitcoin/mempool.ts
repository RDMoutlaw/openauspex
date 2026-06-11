import type { BitcoinProvider, BlockInfo } from './provider.js';
import { defaultFetch, type FetchLike } from './http.js';

export interface MempoolProviderOptions {
  /** Esplora-compatible API base (no trailing slash). Defaults to mempool.space. */
  baseUrl?: string;
  /** Override the HTTP client (e.g. for tests). Defaults to the global `fetch`. */
  fetchFn?: FetchLike;
}

/**
 * {@link BitcoinProvider} backed by an Esplora-compatible REST API such as mempool.space or
 * blockstream.info. Endpoints used:
 *   GET /block-height/:height   → block hash (text)
 *   GET /block/:hash            → block JSON ({ id, height, timestamp, … })
 *   GET /blocks/tip/height      → tip height (text)
 */
export class MempoolProvider implements BitcoinProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: MempoolProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://mempool.space/api').replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? defaultFetch();
  }

  async getBlockHashByHeight(height: number): Promise<string> {
    const text = (await this.getText(`/block-height/${height}`)).trim();
    if (!/^[0-9a-f]{64}$/.test(text)) {
      throw new Error(`unexpected block hash for height ${height}: "${text}"`);
    }
    return text;
  }

  async getBlock(hash: string): Promise<BlockInfo> {
    const data = (await this.getJson(`/block/${hash}`)) as {
      id?: unknown;
      height?: unknown;
      timestamp?: unknown;
    };
    if (
      typeof data.id !== 'string' ||
      typeof data.height !== 'number' ||
      typeof data.timestamp !== 'number'
    ) {
      throw new Error(`malformed block response for ${hash}`);
    }
    return { height: data.height, hash: data.id, timestamp: data.timestamp };
  }

  async getTipHeight(): Promise<number> {
    const n = Number((await this.getText('/blocks/tip/height')).trim());
    if (!Number.isInteger(n)) throw new Error('unexpected tip height response');
    return n;
  }

  private async getText(path: string): Promise<string> {
    const res = await this.fetchFn(this.baseUrl + path);
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return res.text();
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetchFn(this.baseUrl + path);
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return res.json();
  }
}
