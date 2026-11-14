# @pandafile/sdk

The official JavaScript / TypeScript SDK and command line for [Pandafile](https://pandafile.co): send files of any size
with resumable uploads, collect files with file requests, get documents signed and react to webhooks.

- Zero runtime dependencies. Node 18+, browsers, Deno, Bun, edge runtimes (anything with `fetch`).
- ESM and CommonJS, full TypeScript types generated from the [OpenAPI document](https://pandafile.co/api/v1/openapi.json).
- `transfers.send()` does everything: create, upload (tus, chunked, parallel, resumable), complete, return the link.
- Automatic `Idempotency-Key` on every POST/PATCH/PUT, retries with backoff on 429/5xx honouring `Retry-After`,
  typed errors, auto-pagination, webhook signature verification.

The API is included with Pandafile Pro and Team. Create a key in **Dashboard → Domain & API**.

## Install

```sh
npm install @pandafile/sdk
```

## Quick start

```ts
import Pandafile from '@pandafile/sdk';

const pf = new Pandafile({ apiKey: process.env.PANDAFILE_API_KEY }); // pf_live_… or pf_test_…

const { url } = await pf.transfers.send({
  files: ['final-cut.mov', 'stills/'],          // folders keep their structure
  recipients: ['client@example.com'],
  title: 'Final cut',
  onProgress: (p) => console.log(`${p.percent.toFixed(1)} %`),
});
console.log(url); // https://pandafile.co/d/k3x9q2m7ab
```

In the browser pass `File` objects (from `<input type="file" webkitdirectory>` the folder paths are kept) or
`{ name, data }` with a `Uint8Array`, `Blob`, `ArrayBuffer` or string. Never put a live key in browser code that
strangers can read – create transfers from your server instead.

CommonJS:

```js
const { Pandafile } = require('@pandafile/sdk');
```

## Resumable sends

Uploads already resume after dropped connections within a process. To resume across processes, save the state:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
let state = null;
try { state = JSON.parse(readFileSync('send-state.json', 'utf8')); } catch {}
const res = await pf.transfers.send({
  files: ['huge.mxf'],
  state,                                                   // finished files are skipped, the rest continues
  onState: (s) => writeFileSync('send-state.json', JSON.stringify(s)),
});
```

## Every endpoint

```ts
await pf.me.retrieve();                                   // plan, limits, usage
for await (const t of pf.transfers.list({ view: 'active' })) console.log(t.id, t.title);  // auto-pagination
const page = await pf.transfers.list({ limit: 50 });     // or one page: page.data, page.has_more, page.nextPage()
await pf.transfers.retrieve('k3x9q2m7ab');
await pf.transfers.update('k3x9q2m7ab', { title: 'v2', password: 'blue-river-42' });
await pf.transfers.addRecipients('k3x9q2m7ab', ['producer@example.com']);
await pf.transfers.delete('k3x9q2m7ab');

const req = await pf.requests.create({ title: 'Photos from the wedding' });  // file requests
const draft = await pf.signatures.create('nda.pdf');                         // e-signatures
await pf.signatures.send(draft.id, { signers: [{ name: 'Ada', email: 'ada@example.com' }],
  fields: [{ signer: 0, kind: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }] });

await pf.branding.update({ name: 'Studio Nord', color: '#1F7A4D' });
await pf.team.invite(['sam@example.com']);
await pf.events.list({ since: '2026-11-25T00:00:00Z', type: 'transfer.downloaded' });
await pf.hooks.create({ url: 'https://example.com/pandafile-webhook', events: ['transfer.ready'] });
await pf.keys.list(); await pf.domains.list();
await pf.request('GET', '/me');                           // anything else, by hand
```

Types for every request and response are exported (`Transfer`, `TransferDetail`, `CreateTransferBody`, `Event`, …).

## Errors

```ts
import { NotFoundError, RateLimitError, PandafileError } from '@pandafile/sdk';
try {
  await pf.transfers.retrieve('nope1234');
} catch (e) {
  if (e instanceof NotFoundError) console.log(e.code);    // resource_missing
  if (e instanceof PandafileError) console.log(e.type, e.code, e.status, e.requestId, e.param);
}
```

Classes: `InvalidRequestError` (`NotFoundError`), `AuthenticationError`, `PermissionError`, `IdempotencyError`,
`RateLimitError` (`retryAfter`), `APIError`, `ConnectionError`, `UploadError`, `SignatureVerificationError`.

## Webhooks

```ts
import express from 'express';
import Pandafile from '@pandafile/sdk';

app.post('/pandafile-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const ok = await Pandafile.webhooks.verify(req.body, req.get('Pandafile-Signature'), process.env.PANDAFILE_WEBHOOK_SECRET, 300);
  if (!ok) return res.sendStatus(400);
  const event = JSON.parse(req.body);
  res.sendStatus(200);
});
```

`Pandafile.webhooks.constructEvent(body, header, secret)` verifies and parses in one go (throws on a bad signature).

## Options

```ts
new Pandafile({
  apiKey: 'pf_live_…',           // default: PANDAFILE_API_KEY
  baseUrl: 'https://pandafile.co', // default: PANDAFILE_BASE_URL or https://pandafile.co
  maxRetries: 3,                 // 429, 5xx, network errors
  timeout: 60_000,               // per request, ms
  fetch,                         // your own fetch
});
```

Per call: `{ idempotencyKey, maxRetries, timeout, signal, headers }` as the last argument.
`pf.http.lastResponse.headers` holds the `ratelimit-*` headers of the last call.

## Command line

```sh
npx @pandafile/sdk login                 # or: npm i -g @pandafile/sdk  →  pandafile login
pandafile send film.mov stills/ --to client@example.com --title "Final cut"
pandafile ls
pandafile info k3x9q2m7ab
pandafile rm k3x9q2m7ab
pandafile request create --title "Upload your photos"
pandafile webhook listen --forward http://localhost:3000/pandafile-webhook
```

`--json` on every command for scripts, `--test` to use your test key. An interrupted `send` resumes when you run the
same command again. The key is stored owner-only (0600) in the OS config directory
(`~/Library/Application Support/pandafile`, `~/.config/pandafile`, `%APPDATA%\pandafile`).

## Links

- Guide: https://pandafile.co/developers
- API reference: https://pandafile.co/developers/api
- SDKs: https://pandafile.co/developers/sdks
