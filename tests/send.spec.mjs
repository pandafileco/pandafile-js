// transfers.send(): create → tus uploads → complete, folders, inputs, progress and resume from a saved state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pandafile, prepareFiles } from '../dist/esm/index.js';
import { startMock } from './mock-server.mjs';

let m, dir;
before(async () => {
  m = await startMock();
  dir = mkdtempSync(path.join(tmpdir(), 'pf-sdk-send-'));
  mkdirSync(path.join(dir, 'shoot', 'day1'), { recursive: true });
  writeFileSync(path.join(dir, 'shoot', 'a.txt'), 'hello');
  writeFileSync(path.join(dir, 'shoot', 'day1', 'b.bin'), Buffer.alloc(5000, 1));
  writeFileSync(path.join(dir, 'shoot', '.DS_Store'), 'x');
  writeFileSync(path.join(dir, 'film.mov'), Buffer.alloc(12_000, 2));
});
after(async () => { await m.close(); rmSync(dir, { recursive: true, force: true }); });

const pf = () => new Pandafile({ apiKey: 'pf_test_' + 'b'.repeat(32), baseUrl: m.url });
const contents = (transferId) => Object.fromEntries([...m.state.uploads.values()].filter((u) => u.transferId === transferId).map((u) => [u.meta.filename, Buffer.concat(u.data)]));

test('prepareFiles keeps folder structure like the website and skips .DS_Store', async () => {
  const files = await prepareFiles([path.join(dir, 'shoot'), path.join(dir, 'film.mov'), { name: 'notes.txt', data: 'hi' }, new Blob(['xyz'], { type: 'text/plain' }), { name: 'notes.txt', data: 'again' }]);
  assert.deepEqual(files.map((f) => [f.name, f.size]), [['shoot/a.txt', 5], ['shoot/day1/b.bin', 5000], ['film.mov', 12000], ['notes.txt', 2], ['file', 3], ['notes (1).txt', 5]]);
  assert.equal(files.find((f) => f.name === 'film.mov').type, 'video/quicktime');
  for (const f of files) await f.source.close?.();
  await assert.rejects(prepareFiles(path.join(dir, 'missing.txt')), /No such file or folder/);
});

test('send creates, uploads every file and completes; returns the link', async () => {
  const progress = [];
  const r = await pf().transfers.send({
    files: [path.join(dir, 'shoot'), path.join(dir, 'film.mov'), { name: 'mem.txt', data: new TextEncoder().encode('in memory') }],
    title: 'Shoot', message: 'Hi', recipients: ['c@example.com'], chunkSize: 4096, concurrency: 2,
    onProgress: (p) => progress.push(p),
  });
  assert.match(r.url, /\/d\/tr\d+$/);
  assert.equal(r.resumed, false);
  assert.equal(r.bytes, 5 + 5000 + 12000 + 9);
  const create = m.requests.find((x) => x.method === 'POST' && x.path === '/api/v1/transfers' && x.body?.title === 'Shoot');
  assert.deepEqual(create.body.files.map((f) => f.name), ['shoot/a.txt', 'shoot/day1/b.bin', 'film.mov', 'mem.txt']);
  assert.deepEqual(create.body.recipients, ['c@example.com']);
  assert.ok(create.headers['idempotency-key']);
  const c = contents(r.id);
  assert.equal(c['shoot/a.txt'].toString(), 'hello');
  assert.equal(c['shoot/day1/b.bin'].length, 5000);
  assert.equal(c['film.mov'].length, 12000);
  assert.equal(c['mem.txt'].toString(), 'in memory');
  assert.equal(m.state.transfers.get(r.id).status, 'ready');
  // progress: phases in order, bytes never go down, ends at 100 %
  const phases = [...new Set(progress.map((p) => p.phase))];
  assert.deepEqual(phases, ['creating', 'uploading', 'completing', 'done']);
  const up = progress.map((p) => p.bytesUploaded);
  assert.ok(up.every((v, i) => i === 0 || v >= up[i - 1]));
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).filesDone, 4);
});

test('a saved state resumes: no new transfer, finished files skipped, the unfinished one continues', async () => {
  const files = [{ name: 'one.bin', data: new Uint8Array(3000).fill(3) }, { name: 'two.bin', data: new Uint8Array(9000).fill(4) }];
  let saved = null;
  const ac = new AbortController();
  await assert.rejects(pf().transfers.send({
    files, concurrency: 1, chunkSize: 2000, signal: ac.signal,
    onState: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    onProgress: (p) => { if (p.file?.name === 'two.bin' && p.file.bytesUploaded >= 4000) ac.abort(); },
  }));
  assert.ok(saved?.files['one.bin'].done);
  assert.ok(saved.files['two.bin'].uploadUrl && !saved.files['two.bin'].done);
  const id = saved.transferId;
  const before = m.requests.length;
  const r = await pf().transfers.send({ files, concurrency: 1, chunkSize: 2000, state: saved });
  assert.equal(r.id, id);
  assert.equal(r.resumed, true);
  const reqs = m.requests.slice(before);
  assert.ok(!reqs.some((x) => x.method === 'POST' && x.path === '/api/v1/transfers'), 'no second create');
  assert.ok(!reqs.some((x) => x.method === 'POST' && x.path === '/api/upload'), 'no new tus upload');
  assert.deepEqual(reqs.filter((x) => x.method === 'PATCH').map((x) => x.headers['upload-offset']), ['4000', '6000', '8000']);
  const c = contents(id);
  assert.equal(c['one.bin'].length, 3000);
  assert.deepEqual(c['two.bin'], Buffer.alloc(9000, 4));
});

test('a state for other files, or for a finished transfer, is handled', async () => {
  const files = [{ name: 'x.txt', data: 'x' }];
  const done = await pf().transfers.send({ files });
  // state of a transfer that already completed → returns its link without uploading again
  const state = { version: 1, transferId: done.id, ownerToken: 'own_' + done.id, url: done.url, uploadEndpoint: m.url + '/api/upload', files: { 'x.txt': { size: 1, fingerprint: 'x.txt:1', done: true } } };
  const before = m.requests.length;
  const again = await pf().transfers.send({ files, state });
  assert.equal(again.id, done.id);
  assert.ok(!m.requests.slice(before).some((x) => x.method === 'PATCH' || x.path === '/api/v1/transfers'));
  // state for different files → ignored, a new transfer is made
  const other = await pf().transfers.send({ files: [{ name: 'y.txt', data: 'yy' }], state });
  assert.notEqual(other.id, done.id);
});
