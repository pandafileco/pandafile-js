// transfers.send(): create → upload every file with tus (parallel, chunked, resumable) → complete → the link.
import type { HttpClient } from './client.js';
import type { Transfers } from './resources.js';
import type { TransferCreated } from './generated/types.js';
import { prepareFiles, type FileInput, type PreparedFile } from './files.js';
import { tusUpload, DEFAULT_CHUNK_SIZE } from './tus.js';
import { PandafileError, InvalidRequestError } from './errors.js';
import { abortError, sleep } from './util.js';

export interface SendProgress {
  phase: 'creating' | 'uploading' | 'completing' | 'done';
  bytesUploaded: number;
  bytesTotal: number;
  /** 0–100 */
  percent: number;
  filesDone: number;
  filesTotal: number;
  /** The file this update is about (uploading phase). */
  file?: { name: string; bytesUploaded: number; bytesTotal: number };
}

/** Everything needed to resume a send in a later process. Save it from onState, pass it back as state. */
export interface SendState {
  version: 1;
  transferId: string;
  ownerToken: string;
  url: string;
  uploadEndpoint: string;
  livemode?: boolean;
  files: Record<string, { size: number; fingerprint: string; uploadUrl?: string; done?: boolean }>;
}

export interface SendOptions {
  files: FileInput | FileInput[];
  /** Emailed a personal link when the transfer completes (never in test mode). */
  recipients?: string[];
  title?: string;
  message?: string;
  /** Download password (Pro/Team). */
  password?: string;
  onProgress?: (p: SendProgress) => void;
  /** Files uploaded at the same time (default 3). */
  concurrency?: number;
  /** Bytes per tus PATCH request (default 16 MiB). */
  chunkSize?: number;
  signal?: AbortSignal;
  /** A state saved by onState in an earlier run: finished files are skipped, unfinished ones continue where they stopped. */
  state?: SendState | null;
  /** Called whenever the resumable state changes (transfer created, an upload started, a file finished). */
  onState?: (state: SendState) => void | Promise<void>;
}

export interface SendResult {
  id: string;
  /** The share link. */
  url: string;
  files: { name: string; size: number }[];
  bytes: number;
  /** The create response (ownerToken, uploadEndpoint, expiresInDays, livemode, …). Null when resumed from a state. */
  transfer: TransferCreated | null;
  /** true when an earlier run's state was continued. */
  resumed: boolean;
}

function stateMatches(state: SendState | null | undefined, files: PreparedFile[]): state is SendState {
  if (!state || state.version !== 1 || !state.transferId || !state.ownerToken) return false;
  const names = Object.keys(state.files || {});
  if (names.length !== files.length) return false;
  return files.every((f) => state.files[f.name]?.size === f.size && state.files[f.name]?.fingerprint === f.fingerprint);
}

export async function sendTransfer(client: HttpClient, transfers: Transfers, o: SendOptions): Promise<SendResult> {
  const check = () => { if (o.signal?.aborted) throw abortError(o.signal); };
  const files = await prepareFiles(o.files);
  const bytesTotal = files.reduce((s, f) => s + f.size, 0);
  const sent = new Array<number>(files.length).fill(0);
  let filesDone = 0;
  const progress = (phase: SendProgress['phase'], file?: SendProgress['file']) => {
    if (!o.onProgress) return;
    const up = sent.reduce((a, b) => a + b, 0);
    o.onProgress({ phase, bytesUploaded: up, bytesTotal, percent: bytesTotal ? Math.min(100, (up / bytesTotal) * 100) : 100, filesDone, filesTotal: files.length, file });
  };

  try {
    let state: SendState | null = null;
    let created: TransferCreated | null = null;
    let resumed = false;

    // Resume: only when the earlier transfer is the same set of files and still waiting for uploads.
    if (stateMatches(o.state, files)) {
      const t = await transfers.retrieve(o.state.transferId).catch((e) => { if (e instanceof InvalidRequestError) return null; throw e; });
      const status = t?.transfer?.status;
      if (status === 'ready') {
        progress('done');
        return { id: o.state.transferId, url: t!.transfer.url || o.state.url, files: files.map((f) => ({ name: f.name, size: f.size })), bytes: bytesTotal, transfer: null, resumed: true };
      }
      if (status === 'uploading') { state = o.state; resumed = true; }
    }

    if (!state) {
      progress('creating');
      check();
      created = await transfers.create({
        files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        ...(o.title !== undefined ? { title: o.title } : {}),
        ...(o.message !== undefined ? { message: o.message } : {}),
        ...(o.recipients?.length ? { recipients: o.recipients } : {}),
        ...(o.password ? { password: o.password } : {}),
      }, { signal: o.signal });
      state = {
        version: 1, transferId: created.id, ownerToken: created.ownerToken, url: created.url, uploadEndpoint: created.uploadEndpoint, livemode: created.livemode,
        files: Object.fromEntries(files.map((f) => [f.name, { size: f.size, fingerprint: f.fingerprint }])),
      };
      await o.onState?.(state);
    }
    const st = state;
    let saving = Promise.resolve();
    const save = () => { if (o.onState) saving = saving.then(() => o.onState!(st)).catch(() => {}); return saving; };

    // ----- uploads -----
    const queue = files.map((f, i) => ({ f, i }));
    const concurrency = Math.max(1, Math.min(o.concurrency ?? 3, files.length));
    progress('uploading');
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        check();
        const { f, i } = job;
        const entry = st.files[f.name];
        if (entry.done) { sent[i] = f.size; filesDone++; progress('uploading', { name: f.name, bytesUploaded: f.size, bytesTotal: f.size }); continue; }
        await tusUpload(f.source, {
          endpoint: st.uploadEndpoint,
          metadata: { transferId: st.transferId, ownerToken: st.ownerToken, filename: f.name, filetype: f.type },
          chunkSize: o.chunkSize ?? DEFAULT_CHUNK_SIZE,
          uploadUrl: entry.uploadUrl,
          signal: o.signal,
          fetch: client.fetch,
          onUploadUrl: (u) => { entry.uploadUrl = u; save(); },
          onProgress: (b) => { sent[i] = b; progress('uploading', { name: f.name, bytesUploaded: b, bytesTotal: f.size }); },
        }).finally(() => f.source.close?.());
        entry.done = true;
        sent[i] = f.size;
        filesDone++;
        await save();
        progress('uploading', { name: f.name, bytesUploaded: f.size, bytesTotal: f.size });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // ----- complete -----
    progress('completing');
    let out;
    for (let attempt = 0; ; attempt++) {
      check();
      try { out = await transfers.complete(st.transferId, { ownerToken: st.ownerToken }, { signal: o.signal }); break; }
      catch (e) {
        // A just-finished upload can take a moment to be marked complete.
        if (e instanceof PandafileError && e.code === 'still_uploading' && attempt < 5) { await sleep(500 * (attempt + 1), o.signal); continue; }
        throw e;
      }
    }
    progress('done');
    return { id: st.transferId, url: out.url || st.url, files: files.map((f) => ({ name: f.name, size: f.size })), bytes: bytesTotal, transfer: created, resumed };
  } finally {
    await Promise.all(files.map((f) => f.source.close?.().catch(() => {})));
  }
}
