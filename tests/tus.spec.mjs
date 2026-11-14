// The tus client against an in-memory tus server: creation, chunking, metadata, resume, recovery, permanent errors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tusUpload, encodeMetadata, UploadError } from '../dist/esm/index.js';
import { startMock } from './mock-server.mjs';

let m;
before(async () => { m = await startMock(); });
after(() => m.close());

const bytes = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7) % 251; return b; };
const src = (b) => ({ size: b.length, read: async (s, e) => b.subarray(s, e) });
function transfer() {
  const id = 'tr' + Math.random().toString(36).slice(2, 10);
  m.state.transfers.set(id, { id, ownerToken: 'own', status: 'uploading', files: [] });
  return { transferId: id, ownerToken: 'own', filename: 'photos/day1/a.jpg', filetype: 'image/jpeg' };
}
const uploaded = (url) => { const u = m.state.uploads.get(url.split('/').pop()); return Buffer.concat(u.data); };

test('encodeMetadata: key base64(value) pairs', () => {
  assert.equal(encodeMetadata({ filename: 'a/ø.txt', transferId: 'x' }), `filename ${Buffer.from('a/ø.txt').toString('base64')},transferId eA==`);
});

test('creates the upload, PATCHes it in chunks with offsets and reports progress', async () => {
  const data = bytes(10_000);
  const meta = transfer();
  const progress = [];
  const before = m.requests.length;
  const r = await tusUpload(src(data), { endpoint: m.url + '/api/upload', metadata: meta, chunkSize: 3000, onProgress: (b, t) => progress.push([b, t]) });
  assert.match(r.uploadUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/upload\/up\d+$/, 'relative Location resolved against the endpoint');
  assert.equal(r.resumedFrom, 0);
  const reqs = m.requests.slice(before);
  assert.equal(reqs[0].method, 'POST');
  assert.equal(reqs[0].headers['tus-resumable'], '1.0.0');
  assert.equal(reqs[0].headers['upload-length'], '10000');
  const patches = reqs.filter((x) => x.method === 'PATCH');
  assert.deepEqual(patches.map((x) => [x.headers['upload-offset'], x.bodyLength]), [['0', 3000], ['3000', 3000], ['6000', 3000], ['9000', 1000]]);
  assert.deepEqual(progress.map((p) => p[0]), [0, 3000, 6000, 9000, 10000]);
  assert.deepEqual(uploaded(r.uploadUrl), Buffer.from(data));
  const u = m.state.uploads.get(r.uploadUrl.split('/').pop());
  assert.deepEqual(u.meta, meta, 'metadata decoded by the server');
});

test('resumes an existing upload from the server offset (HEAD) and only sends the rest', async () => {
  const data = bytes(8000);
  const meta = transfer();
  // first run: stop after the first chunk
  const ac = new AbortController();
  let url;
  await assert.rejects(tusUpload(src(data), { endpoint: m.url + '/api/upload', metadata: meta, chunkSize: 2500, signal: ac.signal,
    onUploadUrl: (u) => { url = u; }, onProgress: (b) => { if (b >= 2500) ac.abort(); } }));
  const u = m.state.uploads.get(url.split('/').pop());
  assert.equal(u.offset, 2500);
  const before = m.requests.length;
  const r = await tusUpload(src(data), { endpoint: m.url + '/api/upload', metadata: meta, chunkSize: 2500, uploadUrl: url });
  assert.equal(r.uploadUrl, url);
  assert.equal(r.resumedFrom, 2500);
  const reqs = m.requests.slice(before);
  assert.equal(reqs[0].method, 'HEAD');
  assert.ok(!reqs.some((x) => x.method === 'POST'), 'no new upload');
  assert.deepEqual(reqs.filter((x) => x.method === 'PATCH').map((x) => x.headers['upload-offset']), ['2500', '5000', '7500']);
  assert.deepEqual(uploaded(url), Buffer.from(data));
});

test('an unknown resume URL (404) starts a fresh upload', async () => {
  const data = bytes(100);
  const r = await tusUpload(src(data), { endpoint: m.url + '/api/upload', metadata: transfer(), uploadUrl: m.url + '/api/upload/gone' });
  assert.notEqual(r.uploadUrl, m.url + '/api/upload/gone');
  assert.deepEqual(uploaded(r.uploadUrl), Buffer.from(data));
});

test('recovers from a failed PATCH (500, dropped connection) by asking the server for its offset', async () => {
  const data = bytes(9000);
  let failures = 0;
  m.hooks.flaky = (req, res, raw, entry, state) => {
    if (req.method !== 'PATCH' || failures >= 2) return false;
    const u = state.uploads.get(entry.path.split('/').pop());
    const off = Number(req.headers['upload-offset']);
    if (!(failures === 0 && off === 3000) && !(failures === 1 && off === 4000)) return false;
    failures++;
    if (failures === 1) {
      // the server stored half of the chunk, then failed
      u.data.push(raw.subarray(0, 1000)); u.offset += 1000;
      res.writeHead(500); res.end('boom'); return true;
    }
    req.socket.destroy(); return true; // connection dropped
  };
  try {
    const r = await tusUpload(src(data), { endpoint: m.url + '/api/upload', metadata: transfer(), chunkSize: 3000, retryDelays: [0, 10, 10] });
    assert.equal(failures, 2);
    assert.deepEqual(uploaded(r.uploadUrl), Buffer.from(data), 'byte-exact after recovery');
  } finally { delete m.hooks.flaky; }
});

test('a 409 offset conflict re-syncs with HEAD', async () => {
  const data = bytes(4000);
  let once = false;
  m.hooks.conflict = (req, res) => { if (req.method === 'PATCH' && !once) { once = true; res.writeHead(409); res.end(); return true; } return false; };
  try {
    const r = await tusUpload(src(data), { endpoint: m.url + '/api/upload', metadata: transfer(), chunkSize: 4000 });
    assert.deepEqual(uploaded(r.uploadUrl), Buffer.from(data));
  } finally { delete m.hooks.conflict; }
});

test('permanent errors (403 unknown transfer, 413) fail at once with UploadError', async () => {
  const before = m.requests.length;
  await assert.rejects(tusUpload(src(bytes(10)), { endpoint: m.url + '/api/upload', metadata: { transferId: 'nope', ownerToken: 'x', filename: 'a' } }),
    (e) => e instanceof UploadError && e.status === 403 && /Unknown transfer/.test(e.message));
  assert.equal(m.requests.length - before, 1, 'not retried');
  m.hooks.big = (req, res) => { if (req.method === 'PATCH') { res.writeHead(413); res.end('This transfer is over its size limit\n'); return true; } return false; };
  try {
    await assert.rejects(tusUpload(src(bytes(10)), { endpoint: m.url + '/api/upload', metadata: transfer() }), (e) => e instanceof UploadError && e.status === 413);
  } finally { delete m.hooks.big; }
});

test('gives up after the retry delays are used', async () => {
  m.hooks.down = (req, res) => { if (req.method === 'PATCH') { res.writeHead(503); res.end(); return true; } return false; };
  try {
    await assert.rejects(tusUpload(src(bytes(10)), { endpoint: m.url + '/api/upload', metadata: transfer(), retryDelays: [0, 5] }), (e) => e instanceof UploadError && e.code === 'upload_failed');
  } finally { delete m.hooks.down; }
});
