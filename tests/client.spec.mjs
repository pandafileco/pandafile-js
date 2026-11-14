// HTTP layer: headers, idempotency keys, retries with backoff / Retry-After, typed errors, timeouts, pagination.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  Pandafile, PandafileError, NotFoundError, RateLimitError, AuthenticationError, PermissionError, APIError, ConnectionError,
  IdempotencyError, InvalidRequestError, API_VERSION,
} from '../dist/esm/index.js';

let server, base, handler, log;
before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    log.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    handler(req, res, raw);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

const KEY = 'pf_test_' + 'a'.repeat(32);
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_' + status, ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const pf = (o = {}) => new Pandafile({ apiKey: KEY, baseUrl: base, ...o });
const reset = (h) => { log = []; handler = h; };

test('sends the key, the pinned Pandafile-Version and a User-Agent; JSON bodies; no Idempotency-Key on GET', async () => {
  reset((req, res) => send(res, 200, { email: 'a@b.c', plan: 'pro' }));
  const me = await pf().me.retrieve();
  assert.equal(me.email, 'a@b.c');
  const h = log[0].headers;
  assert.equal(h.authorization, 'Bearer ' + KEY);
  assert.equal(h['pandafile-version'], API_VERSION);
  assert.match(h['user-agent'], /^pandafile-js\/\d+\.\d+\.\d+ node\//);
  assert.equal(h['idempotency-key'], undefined);
  assert.equal(log[0].url, '/api/v1/me');
});

test('POST gets an automatic Idempotency-Key that stays the same across retries', async () => {
  let n = 0;
  reset((req, res) => (++n < 3 ? send(res, 503, { error: { type: 'api_error', code: 'service_unavailable', message: 'busy' } }, { 'retry-after': '0' }) : send(res, 201, { id: 'r1', title: 'x' })));
  const r = await pf().requests.create({ title: 'x' });
  assert.equal(r.id, 'r1');
  assert.equal(log.length, 3);
  const keys = log.map((l) => l.headers['idempotency-key']);
  assert.match(keys[0], /^[0-9a-f-]{36}$/);
  assert.ok(keys.every((k) => k === keys[0]), 'same key on every attempt');
  assert.deepEqual(JSON.parse(log[0].body), { title: 'x' });
  assert.equal(log[0].headers['content-type'], 'application/json');
  // a second call gets a new key; an explicit one is used as given
  reset((req, res) => send(res, 201, { id: 'r2' }));
  await pf().requests.create({ title: 'y' });
  await pf().requests.create({ title: 'y' }, { idempotencyKey: 'my-key-1' });
  assert.notEqual(log[0].headers['idempotency-key'], keys[0]);
  assert.equal(log[1].headers['idempotency-key'], 'my-key-1');
});

test('429 honours Retry-After (seconds) before retrying', async () => {
  let n = 0;
  reset((req, res) => (++n === 1 ? send(res, 429, { error: { type: 'rate_limit_error', code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '1' }) : send(res, 200, { email: 'x' })));
  const t0 = Date.now();
  await pf().me.retrieve();
  const waited = Date.now() - t0;
  assert.equal(log.length, 2);
  assert.ok(waited >= 950, `waited ${waited} ms`);
});

test('gives up after maxRetries with a typed RateLimitError (retryAfter, requestId)', async () => {
  reset((req, res) => send(res, 429, { error: { type: 'rate_limit_error', code: 'rate_limited', message: 'Too many requests' } }, { 'retry-after': '0', 'x-request-id': 'req_rl' }));
  await assert.rejects(pf({ maxRetries: 2 }).me.retrieve(), (e) => {
    assert.ok(e instanceof RateLimitError && e instanceof PandafileError);
    assert.equal(e.status, 429); assert.equal(e.code, 'rate_limited'); assert.equal(e.type, 'rate_limit_error');
    assert.equal(e.requestId, 'req_rl'); assert.equal(e.retryAfter, 0);
    return true;
  });
  assert.equal(log.length, 3, '1 + 2 retries');
});

test('5xx without Retry-After backs off exponentially; 4xx is never retried', async () => {
  let n = 0;
  reset((req, res) => (++n <= 2 ? send(res, 502, {}) : send(res, 200, { email: 'x' })));
  const t0 = Date.now();
  await pf().me.retrieve();
  assert.equal(log.length, 3);
  assert.ok(Date.now() - t0 >= 250 + 500, 'backoff ≥ 0.25 s + 0.5 s (jittered halves of 0.5 s and 1 s)');
  reset((req, res) => send(res, 400, { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: 'Invalid title', param: 'title' } }));
  await assert.rejects(pf().requests.create({ title: '' }), (e) => e instanceof InvalidRequestError && e.param === 'title' && e.code === 'parameter_invalid');
  assert.equal(log.length, 1);
});

test('maps errors to classes by type and status', async () => {
  const cases = [
    [401, 'authentication_error', AuthenticationError], [403, 'permission_error', PermissionError], [404, 'invalid_request_error', NotFoundError],
    [409, 'idempotency_error', IdempotencyError], [500, 'api_error', APIError],
  ];
  for (const [status, type, Cls] of cases) {
    reset((req, res) => send(res, status, { error: { type, code: 'c_' + status, message: 'm' + status } }, { 'x-request-id': 'req_x' + status }));
    await assert.rejects(pf({ maxRetries: 0 }).transfers.retrieve('abcdef12'), (e) => e instanceof Cls && e.status === status && e.code === 'c_' + status && e.message === 'm' + status && e.requestId === 'req_x' + status);
  }
  // the legacy (2025-06-01) shape {"error": "message"}
  reset((req, res) => send(res, 404, { error: 'Not found' }));
  await assert.rejects(pf().transfers.retrieve('abcdef12'), (e) => e instanceof NotFoundError && e.message === 'Not found' && e.code === 'resource_missing');
});

test('an idempotency_key_in_use conflict is retried', async () => {
  let n = 0;
  reset((req, res) => (++n === 1 ? send(res, 409, { error: { type: 'idempotency_error', code: 'idempotency_key_in_use', message: 'busy' } }) : send(res, 201, { id: 'ok' })));
  assert.equal((await pf().requests.create({ title: 'a' })).id, 'ok');
  assert.equal(log.length, 2);
});

test('network errors become ConnectionError after retries; timeouts too', async () => {
  const dead = new Pandafile({ apiKey: KEY, baseUrl: 'http://127.0.0.1:1', maxRetries: 1 });
  await assert.rejects(dead.me.retrieve(), (e) => e instanceof ConnectionError && e.status === 0 && e.code === 'connection_failed');
  reset(() => { /* never answers */ });
  await assert.rejects(pf({ timeout: 150, maxRetries: 0 }).me.retrieve(), (e) => e instanceof ConnectionError && e.code === 'timeout');
});

test('missing key is an error at construction', () => {
  const saved = process.env.PANDAFILE_API_KEY;
  delete process.env.PANDAFILE_API_KEY;
  assert.throws(() => new Pandafile({ baseUrl: base }), (e) => e instanceof PandafileError && e.code === 'api_key_missing');
  if (saved) process.env.PANDAFILE_API_KEY = saved;
});

test('pagination: await gives the first page; for-await walks every page with starting_after', async () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ id: 'evt_' + i, type: 'transfer.ready' }));
  reset((req, res) => {
    const u = new URL(req.url, base);
    const limit = Number(u.searchParams.get('limit'));
    const after = u.searchParams.get('starting_after');
    const start = after ? all.findIndex((e) => e.id === after) + 1 : 0;
    const data = all.slice(start, start + limit);
    const more = start + limit < all.length;
    send(res, 200, { object: 'list', data, has_more: more, next_cursor: more ? data.at(-1).id : null });
  });
  const page = await pf().events.list({ limit: 3, type: 'transfer.ready' });
  assert.deepEqual(page.data.map((e) => e.id), ['evt_0', 'evt_1', 'evt_2']);
  assert.equal(page.has_more, true);
  assert.equal(page.next_cursor, 'evt_2');
  const p2 = await page.nextPage();
  assert.deepEqual(p2.data.map((e) => e.id), ['evt_3', 'evt_4', 'evt_5']);

  log = [];
  const ids = [];
  for await (const e of pf().events.list({ limit: 3 })) ids.push(e.id);
  assert.deepEqual(ids, all.map((e) => e.id));
  assert.deepEqual(log.map((l) => new URL(l.url, base).searchParams.get('starting_after')), [null, 'evt_2', 'evt_5']);
  assert.ok(log.every((l) => new URL(l.url, base).searchParams.get('limit') === '3'));

  assert.deepEqual((await pf().events.list({ limit: 2 }).toArray(3)).map((e) => e.id), ['evt_0', 'evt_1', 'evt_2']);
  assert.deepEqual((await pf().events.list({ limit: 5, starting_after: 'evt_4' })).data.map((e) => e.id), ['evt_5', 'evt_6']);
});

test('lastResponse exposes rate-limit headers', async () => {
  reset((req, res) => send(res, 200, { email: 'x' }, { 'ratelimit-remaining': '117', 'ratelimit-limit': '120' }));
  const c = pf();
  await c.me.retrieve();
  assert.equal(c.http.lastResponse.headers['ratelimit-remaining'], '117');
});
