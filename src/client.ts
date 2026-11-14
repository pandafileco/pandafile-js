import { API_VERSION } from './generated/types.js';
import { ConnectionError, PandafileError, errorFromResponse } from './errors.js';
import { abortError, backoff, headersToObject, isNode, parseRetryAfter, sleep, uuid } from './util.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://pandafile.co';

export interface ClientOptions {
  /** pf_live_… or pf_test_…. Defaults to the PANDAFILE_API_KEY environment variable (Node). */
  apiKey?: string;
  /** Defaults to https://pandafile.co (or PANDAFILE_BASE_URL). */
  baseUrl?: string;
  /** Pandafile-Version sent with every request. The SDK is built for the version it ships with; change it only when you know why. */
  apiVersion?: string;
  /** Retries for 429, 5xx, network errors and in-flight idempotency conflicts (default 3). */
  maxRetries?: number;
  /** Per-request timeout in milliseconds (default 60 000). */
  timeout?: number;
  /** Your own fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Extra headers for every API request. */
  headers?: Record<string, string>;
  /** Appended to the User-Agent (Node only), e.g. "my-app/1.2". */
  appInfo?: string;
}

export interface RequestOptions {
  /** Defaults to a fresh UUID for POST / PATCH / PUT, reused for every retry of this call. */
  idempotencyKey?: string;
  maxRetries?: number;
  timeout?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** A raw body (PDF, image) instead of JSON. */
  raw?: { data: Uint8Array | Blob | ArrayBuffer; contentType: string };
  /** Return the response body as bytes (PDF downloads). */
  binary?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
  requestId: string | null;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class HttpClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly maxRetries: number;
  readonly timeout: number;
  readonly fetch: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly userAgent: string | null;
  /** The last response's headers, status and request id (rate-limit headers live here). */
  lastResponse: Omit<ApiResponse<unknown>, 'data'> | null = null;

  constructor(opts: ClientOptions = {}) {
    const env = isNode ? process.env : {};
    const key = opts.apiKey ?? env.PANDAFILE_API_KEY;
    if (!key) throw new PandafileError({ message: 'No API key: pass { apiKey } or set PANDAFILE_API_KEY.', type: 'authentication_error', code: 'api_key_missing' });
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? env.PANDAFILE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiVersion = opts.apiVersion ?? API_VERSION;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeout = opts.timeout ?? 60_000;
    const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new PandafileError({ message: 'No fetch available: use Node 18+ or pass { fetch }.', code: 'fetch_missing' });
    this.fetch = f.bind(globalThis) as typeof fetch;
    this.extraHeaders = opts.headers ?? {};
    // Browsers refuse a custom User-Agent, and extra headers would fail CORS: only Node identifies itself.
    this.userAgent = isNode ? `pandafile-js/${VERSION} node/${process.versions.node}${opts.appInfo ? ' ' + opts.appInfo : ''}` : null;
  }

  get livemode(): boolean { return !this.apiKey.startsWith('pf_test_'); }

  url(path: string, query?: Record<string, unknown>): string {
    const u = new URL(this.baseUrl + '/api/v1' + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, v instanceof Date ? v.toISOString() : String(v));
    }
    return u.toString();
  }

  async request<T>(spec: RequestSpec, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestWithResponse<T>(spec, opts)).data;
  }

  async requestWithResponse<T>(spec: RequestSpec, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = this.url(spec.path, spec.query);
    const headers: Record<string, string> = {
      Accept: spec.binary ? '*/*' : 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'Pandafile-Version': this.apiVersion,
      ...this.extraHeaders,
      ...(opts.headers || {}),
    };
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    let body: BodyInit | undefined;
    if (spec.raw) {
      headers['Content-Type'] = spec.raw.contentType;
      body = spec.raw.data as BodyInit;
    } else if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }
    if (['POST', 'PATCH', 'PUT'].includes(spec.method)) headers['Idempotency-Key'] = opts.idempotencyKey ?? uuid();

    const maxRetries = opts.maxRetries ?? this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, { method: spec.method, headers, body }, opts);
      } catch (err) {
        if (opts.signal?.aborted) throw abortError(opts.signal);
        if (attempt < maxRetries) { await sleep(backoff(attempt), opts.signal); continue; }
        const timedOut = (err as Error)?.name === 'TimeoutError';
        throw new ConnectionError({ message: timedOut ? `Request timed out after ${opts.timeout ?? this.timeout} ms` : `Could not reach ${this.baseUrl}: ${(err as Error)?.message || err}`,
          type: 'connection_error', code: timedOut ? 'timeout' : 'connection_failed', cause: err });
      }
      const h = headersToObject(res.headers);
      this.lastResponse = { status: res.status, headers: h, requestId: h['x-request-id'] || null };
      if (res.ok) {
        const data = spec.binary ? new Uint8Array(await res.arrayBuffer()) : await readJson(res);
        return { data: data as T, status: res.status, headers: h, requestId: h['x-request-id'] || null };
      }
      const errBody = await readJson(res).catch(() => null);
      const err = errorFromResponse(res.status, errBody, h);
      const retryable = RETRY_STATUS.has(res.status) || err.code === 'idempotency_key_in_use';
      if (retryable && attempt < maxRetries) {
        const ra = parseRetryAfter(h['retry-after']);
        await sleep(ra !== null ? Math.min(ra, 60) * 1000 : backoff(attempt), opts.signal);
        continue;
      }
      throw err;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
    const ctl = new AbortController();
    const ms = opts.timeout ?? this.timeout;
    const timer = setTimeout(() => {
      const e = new Error('timeout'); e.name = 'TimeoutError'; ctl.abort(e);
    }, ms);
    const onAbort = () => ctl.abort(opts.signal && (opts.signal as { reason?: unknown }).reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted && (ctl.signal as { reason?: Error }).reason?.name === 'TimeoutError') throw (ctl.signal as { reason?: Error }).reason;
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
