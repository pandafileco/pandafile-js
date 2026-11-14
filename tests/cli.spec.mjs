// The pandafile CLI against the mock API: login (key file 0600), whoami, send (folders, --json), ls, info, rm, webhook listen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-server.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pandafile.js');
const KEY = 'pf_test_' + 'c'.repeat(32);
let m, dir, cfg;
before(async () => {
  m = await startMock();
  dir = mkdtempSync(path.join(tmpdir(), 'pf-cli-'));
  cfg = path.join(dir, 'config');
  mkdirSync(path.join(dir, 'album', 'raw'), { recursive: true });
  writeFileSync(path.join(dir, 'album', 'cover.jpg'), Buffer.alloc(2000, 9));
  writeFileSync(path.join(dir, 'album', 'raw', 'img1.cr3'), Buffer.alloc(3000, 8));
});
after(async () => { await m.close(); rmSync(dir, { recursive: true, force: true }); });

function run(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, PANDAFILE_API_KEY: '', PANDAFILE_TEST_KEY: '', PANDAFILE_CONFIG_DIR: cfg, PANDAFILE_BASE_URL: m.url, ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('help and usage errors', async () => {
  const h = await run(['help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /  send <files\/folders…>/);
  const bad = await run(['nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Unknown command/);
  const notLogged = await run(['ls']);
  assert.equal(notLogged.code, 2);
  assert.match(notLogged.stderr, /Not logged in/);
});

test('login verifies the key and stores it owner-only', async () => {
  const r = await run(['login', '--key', KEY, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.email, 'dev@example.com');
  assert.equal(out.livemode, false);
  const file = path.join(cfg, 'config.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).test_key, KEY);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(cfg).mode & 0o777, 0o700);
  }
  const bad = await run(['login', '--key', 'nope']);
  assert.equal(bad.code, 2);
  // the key can also come from stdin
  const piped = await run(['login'], { input: KEY + '\n' });
  assert.equal(piped.code, 0, piped.stderr);
});

test('whoami', async () => {
  const r = await run(['whoami']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /dev@example\.com/);
});

test('send a folder: paths preserved, link printed, --json output', async () => {
  const r = await run(['send', path.join(dir, 'album'), '--title', 'Album', '--to', 'a@example.com', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.url, /\/d\/tr\d+$/);
  assert.deepEqual(out.files.map((f) => f.name), ['album/cover.jpg', 'album/raw/img1.cr3']);
  assert.deepEqual(out.recipients, ['a@example.com']);
  assert.equal(out.livemode, false);
  const create = m.requests.find((x) => x.path === '/api/v1/transfers' && x.method === 'POST' && x.body?.title === 'Album');
  assert.deepEqual(create.body.files.map((f) => f.name), ['album/cover.jpg', 'album/raw/img1.cr3']);
  assert.match(create.headers['user-agent'], /pandafile-cli\//);
  // plain mode prints just the link on stdout
  const plain = await run(['send', path.join(dir, 'album', 'cover.jpg')]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout.trim(), /^http:\/\/127\.0\.0\.1:\d+\/d\/tr\d+$/);
  assert.match(plain.stderr, /uploaded cover\.jpg/);
});

test('ls, info and rm', async () => {
  const ls = await run(['ls']);
  assert.equal(ls.code, 0, ls.stderr);
  assert.match(ls.stdout, /^ID\s+TITLE\s+STATUS/m);
  const list = JSON.parse((await run(['ls', '--json', '--all'])).stdout);
  assert.ok(list.length >= 2);
  const id = list[0].id;
  const info = JSON.parse((await run(['info', id, '--json'])).stdout);
  assert.equal(info.transfer.id, id);
  const noYes = await run(['rm', id]);
  assert.equal(noYes.code, 2, 'non-interactive rm needs --yes');
  const rm = await run(['rm', id, '--yes', '--json']);
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal(JSON.parse(rm.stdout).deleted, true);
  const missing = await run(['info', 'zzzzzzzz', '--json']);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, 'resource_missing');
});

test('webhook listen forwards new events, signed with the secret', async () => {
  const got = [];
  const sink = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    got.push({ headers: req.headers, body });
    res.writeHead(200); res.end('ok');
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const secret = 'whsec_cli_test';
  const p = spawn(process.execPath, [BIN, 'webhook', 'listen', '--forward', `http://127.0.0.1:${sink.address().port}/hook`, '--secret', secret, '--interval', '1', '--max-events', '1', '--json'],
    { env: { ...process.env, PANDAFILE_CONFIG_DIR: cfg, PANDAFILE_BASE_URL: m.url, PANDAFILE_API_KEY: '' } });
  let stdout = '';
  p.stdout.on('data', (d) => { stdout += d; });
  // wait until it is ready, then cause an event
  for (let i = 0; i < 50 && !stdout.includes('"ready"'); i++) await new Promise((r) => setTimeout(r, 100));
  m.state.events.unshift({ id: 'evt_cli1', type: 'transfer.ready', created: Math.floor(Date.now() / 1000), livemode: false, data: { transfer: { id: 'x' } } });
  const code = await new Promise((r) => p.on('close', r));
  sink.close();
  assert.equal(code, 0);
  assert.equal(got.length, 1);
  const { headers, body } = got[0];
  assert.equal(JSON.parse(body).id, 'evt_cli1');
  assert.equal(headers['pandafile-event-type'], 'transfer.ready');
  const [, t, v1] = headers['pandafile-signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  assert.equal(v1, crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[1].event, 'evt_cli1');
  assert.equal(lines[1].status, 200);
});
