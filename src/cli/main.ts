// pandafile – the command line for Pandafile. `pandafile help` lists the commands.
import { parseArgs } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Pandafile } from '../index.js';
import { PandafileError } from '../errors.js';
import { prepareFiles } from '../files.js';
import { signatureHeader } from '../webhooks.js';
import type { SendState } from '../send.js';
import { formatBytes, sleep } from '../util.js';
import { VERSION } from '../version.js';
import { readConfig, writeConfig, configFile, readState, writeState, removeState, pruneStates, type CliConfig } from './config.js';
import { ProgressBar } from './progress.js';

const HELP = `pandafile ${VERSION} – send big files from your terminal (https://pandafile.co)

Usage: pandafile <command> [options]

Commands
  login [--key pf_live_…]         Save an API key (Dashboard → Domain & API). --test for a test key
  logout [--test | --all]          Forget the saved key(s)
  whoami                           Account, plan, usage and the key in use
  send <files/folders…>            Create a transfer, upload (resumable) and print the link
      --to <email>                   Email the link (repeat for more recipients)
      --title <text>  --message <text>  --password <text>
      --expires <30d | 2026-12-31>   Expiry (Pro/Team, live keys)
      --concurrency <n>              Files uploaded at once (default 3)
      --chunk-size <MiB>             Bytes per upload request (default 16)
      --fresh                        Ignore an unfinished earlier run of the same command
  ls [--history] [--search q] [--limit n] [--all]   List transfers
  info <id>                        One transfer: files, recipients, downloads
  rm <id> [--yes]                  Delete a transfer and its files now
  request create --title <t> [--message <m>]   Create a file request (live keys)
  request ls | close <id> | reopen <id> | rm <id>
  webhook listen --forward <url> [--events a,b] [--secret whsec_…] [--interval 2]
                                   Poll events and POST them, signed, to a local URL
  help | version

Global options
  --json        Machine-readable output on stdout
  --test        Use the test key (pf_test_…): nobody is emailed, transfers expire after 24 h
  --key <key>   Use this key (or PANDAFILE_API_KEY / PANDAFILE_TEST_KEY)
  --base-url    API host (default https://pandafile.co, or PANDAFILE_BASE_URL)
  -q, --quiet   No progress output

Docs: https://pandafile.co/developers/sdks`;

const OPTIONS = {
  json: { type: 'boolean' }, test: { type: 'boolean' }, key: { type: 'string' }, 'base-url': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  // send
  to: { type: 'string', multiple: true }, title: { type: 'string' }, message: { type: 'string' }, password: { type: 'string' },
  expires: { type: 'string' }, concurrency: { type: 'string' }, 'chunk-size': { type: 'string' }, fresh: { type: 'boolean' },
  // ls / rm / logout
  history: { type: 'boolean' }, search: { type: 'string' }, limit: { type: 'string' }, all: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
  // webhook listen
  forward: { type: 'string' }, events: { type: 'string' }, secret: { type: 'string' }, interval: { type: 'string' }, 'max-events': { type: 'string' },
} as const;

type Opts = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { multiple: true } ? string[] : (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

class UsageError extends Error {}

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');
const printJson = (v: unknown) => out(JSON.stringify(v, null, 2));
const date = (v: string | null | undefined) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '–');

function table(rows: (string | number)[][], head: string[]): string {
  const all = [head, ...rows.map((r) => r.map((c) => String(c ?? '')))];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

function resolveKey(o: Opts, cfg: CliConfig): string {
  if (o.key) return o.key;
  if (o.test) {
    const k = process.env.PANDAFILE_TEST_KEY || (process.env.PANDAFILE_API_KEY?.startsWith('pf_test_') ? process.env.PANDAFILE_API_KEY : undefined) || cfg.test_key;
    if (!k) throw new UsageError('No test key. Run: pandafile login --test (or set PANDAFILE_TEST_KEY).');
    return k;
  }
  const k = process.env.PANDAFILE_API_KEY || cfg.live_key || (!cfg.live_key && cfg.test_key ? cfg.test_key : undefined);
  if (!k) throw new UsageError('Not logged in. Run: pandafile login (or set PANDAFILE_API_KEY).');
  return k;
}

function client(o: Opts): Pandafile {
  const cfg = readConfig();
  return new Pandafile({ apiKey: resolveKey(o, cfg), baseUrl: o['base-url'] || process.env.PANDAFILE_BASE_URL || cfg.base_url, appInfo: `pandafile-cli/${VERSION}` });
}

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
  if (hidden && process.stdin.isTTY) {
    // Do not echo the key.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes(question)) process.stderr.write(question); };
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden && process.stdin.isTTY) process.stderr.write('\n'); resolve(a.trim()); }));
}

function parseExpires(v: string): string {
  const m = /^(\d{1,3})d$/i.exec(v.trim());
  if (m) return new Date(Date.now() + Number(m[1]) * 86400e3).toISOString();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() + 'T23:59:00Z' : v);
  if (Number.isNaN(d.getTime())) throw new UsageError(`--expires: use a number of days like 30d or a date like 2026-12-31 (got "${v}").`);
  return d.toISOString();
}

const intOpt = (v: string | undefined, name: string, dflt: number, min = 1, max = 1000) => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number from ${min} to ${max}.`);
  return n;
};

// ---------- commands ----------
async function login(o: Opts): Promise<number> {
  let key = o.key || '';
  if (!key) {
    err(`Create a key at ${(o['base-url'] || 'https://pandafile.co').replace(/\/$/, '')}/dashboard#domain`);
    key = await ask(o.test ? 'Test API key (pf_test_…): ' : 'API key (pf_live_… or pf_test_…): ', true);
  }
  if (!/^pf_(live|test)_[A-Za-z0-9_-]{20,80}$/.test(key)) throw new UsageError('That does not look like a Pandafile API key (pf_live_… or pf_test_…).');
  const cfg = readConfig();
  const baseUrl = o['base-url'] || process.env.PANDAFILE_BASE_URL || cfg.base_url;
  const pf = new Pandafile({ apiKey: key, baseUrl, appInfo: `pandafile-cli/${VERSION}` });
  const me = await pf.me.retrieve();
  const test = key.startsWith('pf_test_');
  if (test) cfg.test_key = key; else cfg.live_key = key;
  if (o['base-url']) cfg.base_url = o['base-url'];
  cfg.email = me.email;
  const file = writeConfig(cfg);
  if (o.json) printJson({ ok: true, email: me.email, plan: me.plan, livemode: !test, config: file });
  else out(`Logged in as ${me.email} (${me.plan}${test ? ', test mode' : ''}). Key saved to ${file}`);
  return 0;
}

async function logout(o: Opts): Promise<number> {
  const cfg = readConfig();
  if (o.all) { delete cfg.live_key; delete cfg.test_key; delete cfg.email; }
  else if (o.test) delete cfg.test_key;
  else delete cfg.live_key;
  writeConfig(cfg);
  if (o.json) printJson({ ok: true }); else out('Logged out.');
  return 0;
}

async function whoami(o: Opts): Promise<number> {
  const me = await client(o).me.retrieve();
  if (o.json) { printJson(me); return 0; }
  out(`${me.email}  ·  plan ${me.plan}${me.team ? `  ·  team ${me.team.name || me.team.id} (${me.team.role})` : ''}`);
  out(`key ${me.key?.prefix}…  ${me.key?.mode} mode, ${me.key?.scope} scope`);
  if (me.usage) out(`this month ${formatBytes(me.usage.month_bytes)} in ${me.usage.month_transfers} transfers · storage ${formatBytes(me.usage.storage_bytes)}${me.limits?.storage_bytes ? ' of ' + formatBytes(me.limits.storage_bytes) : ''}`);
  return 0;
}

async function send(o: Opts, args: string[]): Promise<number> {
  if (!args.length) throw new UsageError('Usage: pandafile send <files or folders…> [--to email] [--title text]');
  const pf = client(o);
  const concurrency = intOpt(o.concurrency, 'concurrency', 3, 1, 16);
  const chunkSize = Math.round(intOpt(o['chunk-size'], 'chunk-size', 16, 0.0625, 512) * 1024 * 1024);
  const expiresAt = o.expires ? parseExpires(o.expires) : null;
  const recipients = (o.to || []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);

  // The same command (same files, unchanged, same options, same key) resumes an unfinished earlier run.
  const prepared = await prepareFiles(args);
  const stateId = createHash('sha256').update(JSON.stringify({
    base: pf.http.baseUrl, key: createHash('sha256').update(pf.http.apiKey).digest('hex'),
    files: prepared.map((f) => [f.name, f.fingerprint]), title: o.title ?? null, message: o.message ?? null, recipients, password: o.password ?? null,
  })).digest('hex').slice(0, 32);
  pruneStates();
  const saved = o.fresh ? null : readState<SendState>(stateId);
  for (const f of prepared) await f.source.close?.();

  const total = prepared.reduce((s, f) => s + f.size, 0);
  if (!o.quiet) {
    err(`${saved ? 'Resuming' : 'Sending'} ${prepared.length} file${prepared.length === 1 ? '' : 's'} (${formatBytes(total)})${pf.livemode ? '' : ' in test mode'}${saved ? ` – transfer ${saved.transferId}` : ''}`);
  }
  const bar = new ProgressBar(process.stderr, !!o.quiet);
  const ac = new AbortController();
  const onSig = () => ac.abort(new Error('interrupted'));
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  let res;
  try {
    res = await pf.transfers.send({
      files: args, recipients, title: o.title, message: o.message, password: o.password,
      concurrency, chunkSize, signal: ac.signal, state: saved,
      onState: (s) => writeState(stateId, s),
      onProgress: (p) => bar.update(p),
    });
  } catch (e) {
    bar.done();
    if (ac.signal.aborted) {
      err('Paused. Run the same command again to resume.');
      return 130;
    }
    // A transfer that can no longer take uploads is not worth resuming.
    if (e instanceof PandafileError && e.status && e.status !== 429 && e.status < 500) removeState(stateId);
    else if (readState(stateId)) err('Run the same command again to resume where it stopped.');
    throw e;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
  bar.done();
  removeState(stateId);
  let expiryWarning: string | null = null;
  if (expiresAt) {
    try { await pf.transfers.update(res.id, { expires_at: expiresAt }); }
    catch (e) { expiryWarning = `Could not set the expiry: ${(e as Error).message}`; }
  }
  if (o.json) {
    printJson({ id: res.id, url: res.url, files: res.files, bytes: res.bytes, recipients, resumed: res.resumed, livemode: pf.livemode,
      ...(expiresAt && !expiryWarning ? { expires_at: expiresAt } : {}), ...(expiryWarning ? { warning: expiryWarning } : {}) });
  } else {
    if (expiryWarning) err(expiryWarning);
    if (!o.quiet) err(`Sent ${res.files.length} file${res.files.length === 1 ? '' : 's'} (${formatBytes(res.bytes)})${recipients.length ? ` – emailed ${recipients.join(', ')}` : ''}`);
    out(res.url);
  }
  return 0;
}

async function ls(o: Opts): Promise<number> {
  const pf = client(o);
  const limit = intOpt(o.limit, 'limit', 20, 1, 100000);
  const params = { view: o.history ? 'history' as const : 'active' as const, q: o.search, limit: Math.min(100, limit) };
  const items = o.all ? await pf.transfers.list({ ...params, limit: 100 }).toArray() : await pf.transfers.list(params).toArray(limit);
  if (o.json) { printJson(items); return 0; }
  if (!items.length) { out(o.history ? 'No expired or deleted transfers.' : 'No transfers yet. Send one: pandafile send <file>'); return 0; }
  out(table(items.map((t) => [t.id, (t.title || '–').slice(0, 40), t.status, t.file_count, formatBytes(t.total_bytes), date(t.created_at), date(t.expires_at), t.download_count]),
    ['ID', 'TITLE', 'STATUS', 'FILES', 'SIZE', 'CREATED', 'EXPIRES', 'DOWNLOADS']));
  return 0;
}

async function info(o: Opts, args: string[]): Promise<number> {
  if (!args[0]) throw new UsageError('Usage: pandafile info <transfer id>');
  const d = await client(o).transfers.retrieve(args[0]);
  if (o.json) { printJson(d); return 0; }
  const t = d.transfer;
  out(`${t.title || '(no title)'}  ${t.url || ''}`);
  out(`id ${t.id} · ${t.status} · ${t.file_count} files · ${formatBytes(t.total_bytes)} · ${t.download_count} downloads${t.has_password ? ' · password' : ''}${t.livemode === false ? ' · test' : ''}`);
  out(`created ${date(t.created_at)} · expires ${date(t.expires_at)}`);
  if (t.message) out(`\n${t.message}`);
  if (d.files?.length) { out('\nFiles'); out(table(d.files.map((f) => [f.name, formatBytes(f.size)]), ['NAME', 'SIZE'])); }
  if (d.recipients?.length) { out('\nRecipients'); out(table(d.recipients.map((r) => [r.email, date(r.sent), date(r.downloaded)]), ['EMAIL', 'SENT', 'DOWNLOADED'])); }
  if (d.log?.length) { out('\nLatest downloads'); out(table(d.log.slice(0, 10).map((l) => [date(l.at), l.kind, l.file || 'all (zip)', l.recipient || '–']), ['AT', 'KIND', 'FILE', 'RECIPIENT'])); }
  return 0;
}

async function rm(o: Opts, args: string[]): Promise<number> {
  if (!args[0]) throw new UsageError('Usage: pandafile rm <transfer id> [--yes]');
  if (!o.yes) {
    if (!process.stdin.isTTY) throw new UsageError('Add --yes to delete without a question.');
    const a = await ask(`Delete transfer ${args[0]} and its files now? This cannot be undone. [y/N] `);
    if (!/^y(es)?$/i.test(a)) { err('Nothing deleted.'); return 1; }
  }
  const r = await client(o).transfers.delete(args[0]);
  if (o.json) printJson(r); else out(`Deleted ${args[0]}.`);
  return 0;
}

async function request(o: Opts, args: string[]): Promise<number> {
  const [sub, id] = args;
  const pf = client(o);
  const show = (r: { id: string; title: string; url: string; open: boolean; upload_count: number }) => (o.json ? printJson(r) : out(`${r.url}\n${r.id} · ${r.title} · ${r.open ? 'open' : 'closed'} · ${r.upload_count} uploads`));
  switch (sub) {
    case 'create': {
      if (!o.title) throw new UsageError('Usage: pandafile request create --title <text> [--message <text>]');
      show(await pf.requests.create({ title: o.title, ...(o.message ? { message: o.message } : {}) }));
      return 0;
    }
    case 'ls': case 'list': {
      const items = await pf.requests.list({ limit: 100 }).toArray();
      if (o.json) printJson(items);
      else if (!items.length) out('No file requests yet.');
      else out(table(items.map((r) => [r.id, r.title.slice(0, 40), r.open ? 'open' : 'closed', r.upload_count, date(r.created_at), r.url]), ['ID', 'TITLE', 'STATE', 'UPLOADS', 'CREATED', 'URL']));
      return 0;
    }
    case 'close': case 'reopen': case 'rm': case 'delete': {
      if (!id) throw new UsageError(`Usage: pandafile request ${sub} <id>`);
      if (sub === 'close') show(await pf.requests.close(id));
      else if (sub === 'reopen') show(await pf.requests.reopen(id));
      else { const r = await pf.requests.delete(id); if (o.json) printJson(r); else out(`Deleted file request ${id}.`); }
      return 0;
    }
    default: throw new UsageError('Usage: pandafile request create|ls|close|reopen|rm');
  }
}

async function webhook(o: Opts, args: string[]): Promise<number> {
  if (args[0] !== 'listen') throw new UsageError('Usage: pandafile webhook listen --forward http://localhost:3000/hook');
  if (!o.forward) throw new UsageError('--forward <url> is required, e.g. --forward http://localhost:3000/pandafile-webhook');
  let target: URL;
  try { target = new URL(o.forward); } catch { throw new UsageError(`--forward: not a URL: ${o.forward}`); }
  const pf = client(o);
  const secret = o.secret || 'whsec_' + randomBytes(24).toString('base64url');
  const types = o.events ? o.events.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const intervalMs = intOpt(o.interval, 'interval', 2, 1, 3600) * 1000;
  const maxEvents = o['max-events'] ? intOpt(o['max-events'], 'max-events', 0, 1, 1e9) : Infinity;
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Start after the newest existing event.
  const first = await pf.events.list({ limit: 1 });
  let since: string = first.data[0]?.id || String(Math.floor(Date.now() / 1000));
  const seen = new Set<string>(first.data.map((e) => e.id));
  if (o.json) out(JSON.stringify({ ready: true, forward: target.toString(), secret, livemode: pf.livemode }));
  else {
    err(`Ready! Forwarding ${pf.livemode ? 'live' : 'test'} events to ${target} (polling every ${intervalMs / 1000}s, Ctrl-C to stop)`);
    err(`Webhook signing secret: ${secret}`);
  }
  let forwarded = 0;
  while (!ac.signal.aborted && forwarded < maxEvents) {
    try {
      const fresh = [];
      for await (const e of pf.events.list({ since, limit: 100, ...(types?.length === 1 ? { type: types[0] } : {}) }, { signal: ac.signal })) {
        if (seen.has(e.id)) continue;
        fresh.push(e);
        if (fresh.length >= 1000) break;
      }
      fresh.reverse(); // oldest first
      for (const e of fresh) {
        seen.add(e.id);
        since = e.id;
        if (types && !types.includes(e.type)) continue;
        const body = JSON.stringify(e);
        const started = Date.now();
        let status = 0, error = '';
        try {
          const r = await fetch(target, {
            method: 'POST', body, signal: AbortSignal.timeout(10_000),
            headers: { 'Content-Type': 'application/json', 'User-Agent': `pandafile-cli/${VERSION}`, 'Pandafile-Event-Id': e.id, 'Pandafile-Event-Type': e.type,
              'Pandafile-Delivery': 'cli', 'Pandafile-Signature': await signatureHeader(body, secret) },
          });
          status = r.status;
          await r.arrayBuffer().catch(() => null);
        } catch (x) { error = (x as Error).message; }
        const ms = Date.now() - started;
        if (o.json) out(JSON.stringify({ event: e.id, type: e.type, status, ms, ...(error ? { error } : {}) }));
        else err(`${new Date().toISOString().slice(11, 19)}  --> ${e.type} [${e.id}]  <-- ${status || 'failed'}${error ? ' ' + error : ''} (${ms} ms)`);
        forwarded++;
        if (forwarded >= maxEvents) break;
      }
      if (seen.size > 5000) { const keep = [...seen].slice(-1000); seen.clear(); keep.forEach((k) => seen.add(k)); }
    } catch (x) {
      if (ac.signal.aborted) break;
      err(`polling failed: ${(x as Error).message} – retrying`);
    }
    if (forwarded >= maxEvents) break;
    await sleep(intervalMs, ac.signal).catch(() => {});
  }
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  return 0;
}

// ---------- entry ----------
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS as never, allowPositionals: true, strict: true });
  } catch (e) {
    err(`${(e as Error).message}\nRun pandafile help.`);
    return 2;
  }
  const o = parsed.values as Opts;
  const [cmd, ...args] = parsed.positionals;
  if (o.version || cmd === 'version') { out(VERSION); return 0; }
  if (o.help || !cmd || cmd === 'help') { out(HELP); return cmd || o.help ? 0 : 2; }
  try {
    switch (cmd) {
      case 'login': return await login(o);
      case 'logout': return await logout(o);
      case 'whoami': case 'me': return await whoami(o);
      case 'send': return await send(o, args);
      case 'ls': case 'list': return await ls(o);
      case 'info': case 'show': return await info(o, args);
      case 'rm': case 'delete': return await rm(o, args);
      case 'request': case 'requests': return await request(o, args);
      case 'webhook': case 'webhooks': return await webhook(o, args);
      default: throw new UsageError(`Unknown command "${cmd}". Run pandafile help.`);
    }
  } catch (e) {
    if (e instanceof UsageError) { if (o.json) printJson({ error: { type: 'usage_error', message: e.message } }); else err(e.message); return 2; }
    if (e instanceof PandafileError) {
      if (o.json) printJson({ error: { type: e.type, code: e.code, message: e.message, status: e.status, request_id: e.requestId, ...(e.param ? { param: e.param } : {}) } });
      else err(`Error: ${e.message}${e.code && e.code !== 'unknown' ? ` (${e.code}${e.requestId ? ', ' + e.requestId : ''})` : ''}`);
      if (e.status === 401) err(`Check your key or run: pandafile login${o.test ? ' --test' : ''}  (config: ${configFile()})`);
      return 1;
    }
    throw e;
  }
}

