// An in-memory stand-in for the Pandafile API + tus endpoint, for the SDK and CLI unit tests.
//   const m = await startMock(); m.url; m.requests (log); m.hooks.<name> = (req, res, body) => true (handled)
import http from 'node:http';

export async function startMock() {
  const state = {
    transfers: new Map(), // id → { id, ownerToken, status, files: [{ name, size }], title, … }
    uploads: new Map(),   // uploadId → { transferId, length, offset, meta, data: Buffer[] }
    events: [],
    requests: [],
    seq: 0,
  };
  const hooks = {};
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, bodyLength: raw.length };
    try { entry.body = raw.length && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw.toString()) : undefined; } catch {}
    state.requests.push(entry);
    for (const h of Object.values(hooks)) { if (await h(req, res, raw, entry, state)) return; }
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_mock' + (++state.seq), ...headers }); res.end(JSON.stringify(body)); };
    const p = url.pathname;

    // ----- tus -----
    if (p === '/api/upload' && req.method === 'POST') {
      const meta = Object.fromEntries(String(req.headers['upload-metadata'] || '').split(',').filter(Boolean).map((kv) => {
        const [k, v] = kv.split(' '); return [k, Buffer.from(v || '', 'base64').toString()];
      }));
      const t = state.transfers.get(meta.transferId);
      if (!t || t.ownerToken !== meta.ownerToken) { res.writeHead(403); return res.end('Unknown transfer\n'); }
      const id = 'up' + (++state.seq);
      state.uploads.set(id, { transferId: t.id, length: Number(req.headers['upload-length']), offset: 0, meta, data: [] });
      res.writeHead(201, { location: `/api/upload/${id}`, 'tus-resumable': '1.0.0' }); // relative, like the real server
      return res.end();
    }
    const um = p.match(/^\/api\/upload\/(\w+)$/);
    if (um) {
      const u = state.uploads.get(um[1]);
      if (!u) { res.writeHead(404); return res.end('Upload not found\n'); }
      if (req.method === 'HEAD') { res.writeHead(200, { 'upload-offset': String(u.offset), 'upload-length': String(u.length), 'cache-control': 'no-store' }); return res.end(); }
      if (req.method === 'PATCH') {
        if (Number(req.headers['upload-offset']) !== u.offset) { res.writeHead(409); return res.end('offset mismatch\n'); }
        if (req.headers['content-type'] !== 'application/offset+octet-stream') { res.writeHead(415); return res.end(); }
        u.data.push(raw);
        u.offset += raw.length;
        res.writeHead(204, { 'upload-offset': String(u.offset), 'tus-resumable': '1.0.0' });
        return res.end();
      }
    }

    // ----- API -----
    if (!p.startsWith('/api/v1')) { res.writeHead(404); return res.end(); }
    if (!/^Bearer pf_(live|test)_/.test(req.headers.authorization || '')) return json(401, { error: { type: 'authentication_error', code: 'api_key_invalid', message: 'Invalid API key.' } });
    const live = /^Bearer pf_live_/.test(req.headers.authorization);
    const path = p.slice('/api/v1'.length);
    if (path === '/me') return json(200, { email: 'dev@example.com', plan: 'pro', livemode: live, key: { id: 1, name: 'k', prefix: 'pf_test_abcd', mode: live ? 'live' : 'test', scope: 'full' }, usage: { week_bytes: 0, month_bytes: 0, storage_bytes: 0, week_transfers: 0, month_transfers: 0 } });
    if (path === '/transfers' && req.method === 'POST') {
      const b = entry.body || {};
      const id = 'tr' + String(++state.seq).padStart(6, '0');
      const t = { id, ownerToken: 'own_' + id, status: 'uploading', files: b.files, title: b.title || null, message: b.message || null, recipients: b.recipients || [], created_at: new Date().toISOString() };
      state.transfers.set(id, t);
      const base = `http://${req.headers.host}`;
      return json(201, { id, ownerToken: t.ownerToken, url: `${base}/d/${id}`, uploadEndpoint: `${base}/api/upload`, maxBytes: b.files.reduce((s, f) => s + f.size, 0), expiresInDays: 1, encrypted: false, livemode: live });
    }
    if (path === '/transfers' && req.method === 'GET') {
      const all = [...state.transfers.values()].reverse().map((t) => ({ id: t.id, title: t.title, status: t.status, file_count: t.files.length, total_bytes: t.files.reduce((s, f) => s + f.size, 0), created_at: t.created_at, expires_at: t.created_at, download_count: 0, livemode: live }));
      const limit = Number(url.searchParams.get('limit') || 20);
      const after = url.searchParams.get('starting_after');
      const start = after ? all.findIndex((t) => t.id === after) + 1 : 0;
      const data = all.slice(start, start + limit);
      const more = start + limit < all.length;
      return json(200, { object: 'list', data, has_more: more, next_cursor: more ? data[data.length - 1].id : null });
    }
    const tm = path.match(/^\/transfers\/(\w+)(\/complete)?$/);
    if (tm) {
      const t = state.transfers.get(tm[1]);
      if (!t) return json(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such transfer.' } });
      if (tm[2] && req.method === 'POST') {
        if ((entry.body || {}).ownerToken !== t.ownerToken) return json(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such transfer.' } });
        const ups = [...state.uploads.values()].filter((u) => u.transferId === t.id);
        if (!ups.length || ups.some((u) => u.offset < u.length)) return json(409, { error: { type: 'invalid_request_error', code: 'still_uploading', message: 'Still uploading.' } });
        t.status = 'ready';
        state.events.unshift({ id: 'evt_' + (++state.seq), type: 'transfer.ready', created: Math.floor(Date.now() / 1000), livemode: live, data: { transfer: { id: t.id } } });
        return json(200, { ok: true, url: `http://${req.headers.host}/d/${t.id}` });
      }
      if (req.method === 'GET') return json(200, { transfer: { id: t.id, title: t.title, status: t.status, file_count: t.files.length, total_bytes: 0, url: `http://${req.headers.host}/d/${t.id}`, created_at: t.created_at, expires_at: t.created_at, download_count: 0, livemode: live }, files: t.files.map((f, i) => ({ id: 'f' + i, ...f })), recipients: [], log: [] });
      if (req.method === 'DELETE') { t.status = 'deleted'; return json(200, { ok: true, id: t.id, deleted: true }); }
      if (req.method === 'PATCH') return json(200, { transfer: { id: t.id } });
    }
    if (path === '/events') {
      const limit = Number(url.searchParams.get('limit') || 50);
      let list = state.events;
      const since = url.searchParams.get('since');
      if (since?.startsWith('evt_')) { const i = list.findIndex((e) => e.id === since); list = i < 0 ? list : list.slice(0, i); }
      const after = url.searchParams.get('starting_after');
      const start = after ? list.findIndex((e) => e.id === after) + 1 : 0;
      const data = list.slice(start, start + limit);
      const more = start + limit < list.length;
      return json(200, { object: 'list', data, has_more: more, next_cursor: more ? data[data.length - 1].id : null });
    }
    return json(404, { error: { type: 'invalid_request_error', code: 'route_not_found', message: 'Unrecognized request URL.' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state, hooks, server,
    get requests() { return state.requests; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
