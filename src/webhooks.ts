// Webhook signatures: header "Pandafile-Signature: t=<unix>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>" (one v1 per
// valid secret while a secret is being rotated). Works with Web Crypto (browsers, Node 19+, Deno, Bun, edge runtimes) and
// falls back to node:crypto on Node 18.
import type { Event } from './generated/types.js';
import { SignatureVerificationError } from './errors.js';
import { utf8 } from './util.js';

export const DEFAULT_TOLERANCE = 300;
export const SIGNATURE_HEADER = 'Pandafile-Signature';

type Body = string | Uint8Array | ArrayBuffer;
const bytesOf = (b: Body): Uint8Array => (typeof b === 'string' ? utf8(b) : b instanceof Uint8Array ? b : new Uint8Array(b));
const hex = (buf: ArrayBuffer | Uint8Array): string => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret: string, data: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const key = await subtle.importKey('raw', utf8(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await subtle.sign('HMAC', key, data as BufferSource));
  }
  const nodeCrypto = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:crypto' as string);
  return nodeCrypto.createHmac('sha256', secret).update(data).digest('hex');
}

function payload(t: number | string, body: Body): Uint8Array {
  const head = utf8(`${t}.`);
  const b = bytesOf(body);
  const out = new Uint8Array(head.length + b.length);
  out.set(head, 0); out.set(b, head.length);
  return out;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The hex signature of a body for a timestamp. */
export function computeSignature(secret: string, body: Body, timestamp: number): Promise<string> {
  return hmacHex(secret, payload(timestamp, body));
}

/** A full Pandafile-Signature header value (for tests and local forwarding). */
export async function signatureHeader(body: Body, secret: string | string[], timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const secrets = Array.isArray(secret) ? secret : [secret];
  const sigs = await Promise.all(secrets.map((s) => computeSignature(s, body, timestamp)));
  return `t=${timestamp},` + sigs.map((s) => `v1=${s}`).join(',');
}

/**
 * true when `header` is a valid signature of the raw `body` with `secret`, made at most `toleranceSec` seconds ago.
 * Pass the raw request body exactly as received (not re-serialized JSON).
 */
export async function verify(body: Body, header: string | null | undefined, secret: string, toleranceSec = DEFAULT_TOLERANCE, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = String(header).split(',').map((p) => { const i = p.indexOf('='); return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]; });
  const tRaw = parts.find(([k]) => k === 't')?.[1] ?? '';
  if (!/^\d{1,12}$/.test(tRaw)) return false;
  const t = Number(tRaw);
  if (toleranceSec > 0 && Math.abs(now / 1000 - t) > toleranceSec) return false;
  const want = await computeSignature(secret, body, t);
  let ok = false;
  for (const [k, v] of parts) if (k === 'v1' && safeEqual(v.toLowerCase(), want)) ok = true;
  return ok;
}

/** Verifies and parses an event; throws SignatureVerificationError when the signature is wrong or too old. */
export async function constructEvent<T = Event>(body: Body, header: string | null | undefined, secret: string, toleranceSec = DEFAULT_TOLERANCE): Promise<T> {
  if (!(await verify(body, header, secret, toleranceSec))) {
    throw new SignatureVerificationError({ message: 'Webhook signature verification failed (wrong secret, modified body or timestamp outside the tolerance).',
      type: 'signature_verification_error', code: 'signature_invalid', status: 400 });
  }
  const text = typeof body === 'string' ? body : new TextDecoder().decode(bytesOf(body));
  return JSON.parse(text) as T;
}

export const webhooks = { verify, constructEvent, computeSignature, signatureHeader, DEFAULT_TOLERANCE, SIGNATURE_HEADER };
