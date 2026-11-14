import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pandafile, webhooks, SignatureVerificationError } from '../dist/esm/index.js';

const secret = 'whsec_test_secret_123';
const body = JSON.stringify({ id: 'evt_1', type: 'transfer.ready', created: 1795132800, livemode: false, data: { transfer: { id: 'abc' } } });
// The server's format (src/webhooks.js): t=<unix>,v1=<hex hmac-sha256(secret, `${t}.${body}`)>
const serverHeader = (t, ...secrets) => `t=${t},` + secrets.map((s) => 'v1=' + crypto.createHmac('sha256', s).update(`${t}.${body}`).digest('hex')).join(',');
const now = () => Math.floor(Date.now() / 1000);

test('verify accepts a signature made like the server makes it', async () => {
  assert.equal(await Pandafile.webhooks.verify(body, serverHeader(now(), secret), secret), true);
  assert.equal(await webhooks.verify(new TextEncoder().encode(body), serverHeader(now(), secret), secret), true, 'Uint8Array body');
  assert.equal(await webhooks.verify(Buffer.from(body), serverHeader(now(), secret), secret), true, 'Buffer body');
});

test('verify rejects a modified body, a wrong secret, a missing or malformed header', async () => {
  const h = serverHeader(now(), secret);
  assert.equal(await webhooks.verify(body + ' ', h, secret), false);
  assert.equal(await webhooks.verify(body, h, 'whsec_other'), false);
  assert.equal(await webhooks.verify(body, '', secret), false);
  assert.equal(await webhooks.verify(body, null, secret), false);
  assert.equal(await webhooks.verify(body, 'v1=abc', secret), false);
  assert.equal(await webhooks.verify(body, `t=${now()},v1=zz`, secret), false);
});

test('verify enforces the timestamp tolerance (default 300 s, configurable, 0 = off)', async () => {
  const old = serverHeader(now() - 301, secret);
  assert.equal(await webhooks.verify(body, old, secret), false);
  assert.equal(await webhooks.verify(body, old, secret, 600), true);
  assert.equal(await webhooks.verify(body, serverHeader(now() + 400, secret), secret), false, 'future timestamps too');
  assert.equal(await webhooks.verify(body, serverHeader(1000, secret), secret, 0), true);
});

test('verify accepts any of several v1 values (secret rotation)', async () => {
  const h = serverHeader(now(), 'whsec_new', secret);
  assert.equal(await webhooks.verify(body, h, secret), true);
  assert.equal(await webhooks.verify(body, h, 'whsec_new'), true);
  assert.equal(await webhooks.verify(body, h, 'whsec_third'), false);
});

test('signatureHeader produces what verify accepts and matches node:crypto', async () => {
  const t = now();
  const h = await webhooks.signatureHeader(body, secret, t);
  assert.equal(h, serverHeader(t, secret));
  assert.equal(await webhooks.verify(body, h, secret), true);
});

test('constructEvent parses a valid event and throws SignatureVerificationError otherwise', async () => {
  const evt = await webhooks.constructEvent(body, serverHeader(now(), secret), secret);
  assert.equal(evt.type, 'transfer.ready');
  await assert.rejects(webhooks.constructEvent(body, serverHeader(now(), 'nope'), secret), (e) => e instanceof SignatureVerificationError && e.code === 'signature_invalid');
});
