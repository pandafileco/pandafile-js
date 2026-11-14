export const isNode = typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node
  && typeof (globalThis as { window?: unknown }).window === 'undefined';

export const sleep = (ms: number, signal?: AbortSignal | null): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError(signal));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError(signal!)); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function abortError(signal: AbortSignal): Error {
  const r = (signal as { reason?: unknown }).reason;
  if (r instanceof Error) return r;
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** A random v4 UUID (crypto.randomUUID when there is one: Node 19+, browsers). */
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date), or null. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : Math.max(0, (d - now) / 1000);
}

/** Exponential backoff with jitter: 0.5 s, 1 s, 2 s, … capped at `max` ms. */
export function backoff(attempt: number, base = 500, max = 8000): number {
  const d = Math.min(max, base * 2 ** attempt);
  return Math.round(d / 2 + Math.random() * (d / 2));
}

const enc = new TextEncoder();
export const utf8 = (s: string): Uint8Array => enc.encode(s);

export function base64(s: string): string {
  const bytes = utf8(s);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}
