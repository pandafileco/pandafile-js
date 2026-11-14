// A small tus 1.0.0 client (https://tus.io/protocols/resumable-upload): creation (POST), chunked PATCH with offsets and
// HEAD to resume – on fetch, so it runs in Node 18+, browsers, Deno and Bun with no dependency.
import { UploadError } from './errors.js';
import { abortError, base64, sleep } from './util.js';

export interface UploadSource {
  size: number;
  /** Bytes [start, end). */
  read(start: number, end: number): Promise<Uint8Array | Blob>;
  close?(): Promise<void>;
}

export interface TusUploadOptions {
  endpoint: string;
  metadata: Record<string, string>;
  /** Bytes per PATCH request (default 16 MiB). */
  chunkSize?: number;
  /** An upload URL from an earlier run: resumes at the server's offset when it still exists. */
  uploadUrl?: string | null;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
  /** Called as soon as the upload exists on the server (save it to resume later). */
  onUploadUrl?: (url: string) => void;
  signal?: AbortSignal;
  /** Waits between attempts after a failed request (ms). Default [0, 1000, 3000, 5000, 10000, 20000, 30000]. */
  retryDelays?: number[];
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface TusUploadResult {
  uploadUrl: string;
  /** Offset the upload continued from (0 for a fresh upload). */
  resumedFrom: number;
}

export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
const TUS = { 'Tus-Resumable': '1.0.0' };
const DEFAULT_RETRY = [0, 1000, 3000, 5000, 10000, 20000, 30000];

class Permanent extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k} ${base64(String(v))}`)
    .join(',');
}

export async function tusUpload(source: UploadSource, opts: TusUploadOptions): Promise<TusUploadResult> {
  const f = (opts.fetch ?? globalThis.fetch).bind(globalThis) as typeof fetch;
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const delays = opts.retryDelays ?? DEFAULT_RETRY;
  const signal = opts.signal;
  const size = source.size;
  const extra = opts.headers ?? {};

  const check = () => { if (signal?.aborted) throw abortError(signal); };

  async function head(url: string): Promise<{ offset: number; length: number | null } | null> {
    const r = await f(url, { method: 'HEAD', headers: { ...TUS, ...extra, 'Cache-Control': 'no-store' }, signal });
    if (r.status === 404 || r.status === 410 || r.status === 403) return null;
    if (!r.ok) throw new Error(`HEAD ${r.status}`);
    const offset = Number(r.headers.get('upload-offset'));
    const len = r.headers.get('upload-length');
    if (!Number.isFinite(offset)) throw new Error('HEAD without Upload-Offset');
    return { offset, length: len === null ? null : Number(len) };
  }

  async function create(): Promise<string> {
    const r = await f(opts.endpoint, {
      method: 'POST',
      headers: { ...TUS, ...extra, 'Upload-Length': String(size), 'Upload-Metadata': encodeMetadata(opts.metadata) },
      signal,
    });
    if (r.status !== 201) {
      const text = await r.text().catch(() => '');
      const msg = `Creating the upload failed (${r.status}${text ? ': ' + text.trim() : ''})`;
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new Permanent(msg, r.status);
      throw new Error(msg);
    }
    const loc = r.headers.get('location');
    if (!loc) throw new Permanent('The tus server sent no Location', r.status);
    return new URL(loc, opts.endpoint).toString();
  }

  // Runs fn, retrying temporary failures with the configured delays.
  async function withRetry<T>(fn: () => Promise<T>, onRetry?: () => Promise<void>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      check();
      try { return await fn(); }
      catch (e) {
        if (signal?.aborted) throw abortError(signal);
        if (e instanceof Permanent) throw new UploadError({ message: e.message, type: 'upload_error', code: 'upload_rejected', status: e.status, cause: e });
        if (attempt >= delays.length) {
          throw new UploadError({ message: `Upload failed after ${attempt + 1} attempts: ${(e as Error).message}`, type: 'upload_error', code: 'upload_failed', cause: e });
        }
        await sleep(delays[attempt], signal);
        if (onRetry) await onRetry().catch(() => {});
      }
    }
  }

  let url = opts.uploadUrl || null;
  let offset = 0;
  let resumedFrom = 0;
  if (url) {
    const h = await withRetry(() => head(url!));
    if (h && (h.length === null || h.length === size)) { offset = h.offset; resumedFrom = offset; }
    else url = null;
  }
  if (!url) {
    url = await withRetry(create);
    opts.onUploadUrl?.(url);
  }
  opts.onProgress?.(offset, size);

  let recreated = false;
  while (offset < size) {
    const end = Math.min(size, offset + chunkSize);
    await withRetry(async () => {
      const body = await source.read(offset, end);
      const r = await f(url!, {
        method: 'PATCH',
        headers: { ...TUS, ...extra, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
        body: body as BodyInit,
        signal,
      });
      if (r.ok) {
        const o = Number(r.headers.get('upload-offset'));
        offset = Number.isFinite(o) && o > offset ? o : end;
        opts.onProgress?.(offset, size);
        return;
      }
      if (r.status === 409) { // offset mismatch: ask the server where it is
        const h = await head(url!);
        if (!h) throw new Permanent('The upload disappeared', 404);
        offset = h.offset;
        return;
      }
      if (r.status === 404 && !recreated) { // the server lost the upload: start this file again once
        recreated = true;
        url = await create();
        opts.onUploadUrl?.(url);
        offset = 0;
        opts.onProgress?.(0, size);
        return;
      }
      const text = await r.text().catch(() => '');
      const msg = `Upload failed (${r.status}${text ? ': ' + text.trim() : ''})`;
      if (r.status === 423 || r.status === 408 || r.status === 429 || r.status >= 500) throw new Error(msg);
      throw new Permanent(msg, r.status);
    }, async () => {
      // After a failure the server may have stored part of the chunk.
      const h = await head(url!);
      if (h) offset = h.offset;
    });
  }
  return { uploadUrl: url, resumedFrom };
}
