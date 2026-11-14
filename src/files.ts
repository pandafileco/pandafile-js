// Turns what people pass to transfers.send() into named upload sources:
//   'film.mov' / 'photos/' (Node: paths; folders keep their structure, like dropping a folder on the website)
//   File / Blob (browsers: webkitRelativePath is kept for picked folders)
//   { name, data }  data: Uint8Array | ArrayBuffer | Blob | string
//   { name?, path } (Node)
import type { UploadSource } from './tus.js';
import { PandafileError } from './errors.js';
import { isNode, utf8 } from './util.js';

export type FileData = Uint8Array | ArrayBuffer | Blob | string;
export type FileInput = string | Blob | { name: string; data: FileData; type?: string } | { name?: string; path: string; type?: string };

export interface PreparedFile {
  /** Name on the transfer, with folders ("photos/day1/a.jpg"). */
  name: string;
  size: number;
  type: string;
  source: UploadSource;
  /** Stable identity for resuming (absolute path + size + mtime, or name + size). */
  fingerprint: string;
}

const MIME: Record<string, string> = {
  txt: 'text/plain', csv: 'text/csv', html: 'text/html', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mxf: 'application/mxf',
  mp3: 'audio/mpeg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', m4a: 'audio/mp4',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  psd: 'image/vnd.adobe.photoshop', ai: 'application/postscript', key: 'application/vnd.apple.keynote', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
};
export const mimeOf = (name: string): string => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

// Files that are never worth sending when walking a folder.
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function bytesSource(b: Uint8Array): UploadSource {
  return { size: b.byteLength, read: async (s, e) => b.subarray(s, e) };
}
function blobSource(b: Blob): UploadSource {
  return { size: b.size, read: async (s, e) => b.slice(s, e) };
}

// node:fs is only loaded when a path is given, so browser bundles never need it.
const nodeMod = (name: string): Promise<any> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);

async function pathSource(abs: string, size: number): Promise<UploadSource> {
  const fs = await nodeMod('node:fs/promises');
  let fh: any = null;
  return {
    size,
    async read(s, e) {
      fh ||= await fs.open(abs, 'r');
      const buf = new Uint8Array(e - s);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, s + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return got === buf.length ? buf : buf.subarray(0, got);
    },
    async close() { if (fh) { const h = fh; fh = null; await h.close(); } },
  };
}

async function fromPath(p: string, nameOverride: string | undefined, type: string | undefined, out: PreparedFile[]): Promise<void> {
  if (!isNode) throw new PandafileError({ message: 'File paths only work in Node; pass File or { name, data } in the browser.', code: 'path_unsupported' });
  const fs = await nodeMod('node:fs/promises');
  const path = await nodeMod('node:path');
  const abs = path.resolve(p);
  let st;
  try { st = await fs.stat(abs); }
  catch { throw new PandafileError({ message: `No such file or folder: ${p}`, code: 'file_not_found' }); }
  if (st.isDirectory()) {
    // "photos/" → photos/a.jpg, photos/day1/b.jpg (the folder's own name is kept, as on the website).
    const root = nameOverride ?? path.basename(abs);
    const walk = async (dir: string, rel: string) => {
      const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a: any, b: any) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (SKIP.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        let s;
        try { s = await fs.stat(full); } catch { continue; } // broken symlink
        if (s.isDirectory()) await walk(full, r);
        else if (s.isFile()) out.push({ name: r, size: s.size, type: mimeOf(ent.name), source: await pathSource(full, s.size), fingerprint: `${full}:${s.size}:${s.mtimeMs}` });
      }
    };
    await walk(abs, root);
    return;
  }
  const name = nameOverride ?? path.basename(abs);
  out.push({ name, size: st.size, type: type || mimeOf(name), source: await pathSource(abs, st.size), fingerprint: `${abs}:${st.size}:${st.mtimeMs}` });
}

export async function prepareFiles(input: FileInput | FileInput[]): Promise<PreparedFile[]> {
  const list = Array.isArray(input) ? input : [input];
  const out: PreparedFile[] = [];
  for (const item of list) {
    if (typeof item === 'string') { await fromPath(item, undefined, undefined, out); continue; }
    if (typeof Blob !== 'undefined' && item instanceof Blob) {
      const f = item as Blob & { name?: string; webkitRelativePath?: string; lastModified?: number };
      const name = (f.webkitRelativePath || f.name || 'file').replace(/^\/+/, '');
      out.push({ name, size: f.size, type: f.type || mimeOf(name), source: blobSource(f), fingerprint: `${name}:${f.size}:${f.lastModified ?? ''}` });
      continue;
    }
    if (item && typeof item === 'object' && 'path' in item && typeof item.path === 'string') { await fromPath(item.path, item.name, item.type, out); continue; }
    if (item && typeof item === 'object' && 'data' in item) {
      const d = item.data;
      const name = String(item.name || 'file').replace(/^\/+/, '');
      let source: UploadSource;
      if (typeof d === 'string') source = bytesSource(utf8(d));
      else if (d instanceof Uint8Array) source = bytesSource(d);
      else if (d instanceof ArrayBuffer) source = bytesSource(new Uint8Array(d));
      else if (typeof Blob !== 'undefined' && d instanceof Blob) source = blobSource(d);
      else throw new PandafileError({ message: `Unsupported data for ${name}`, code: 'parameter_invalid', param: 'files' });
      out.push({ name, size: source.size, type: item.type || mimeOf(name), source, fingerprint: `${name}:${source.size}` });
      continue;
    }
    throw new PandafileError({ message: 'Each file must be a path, a File/Blob, { name, data } or { path }.', code: 'parameter_invalid', param: 'files' });
  }
  if (!out.length) throw new PandafileError({ message: 'No files to send (empty folder?).', code: 'parameter_missing', param: 'files' });
  // Names are unique per transfer: "a.txt", "a (1).txt".
  const seen = new Set<string>();
  for (const f of out) {
    let n = f.name, i = 1;
    while (seen.has(n)) {
      const dot = f.name.lastIndexOf('.');
      const slash = f.name.lastIndexOf('/');
      n = dot > slash + 1 ? `${f.name.slice(0, dot)} (${i})${f.name.slice(dot)}` : `${f.name} (${i})`;
      i++;
    }
    seen.add(n);
    f.name = n;
  }
  return out;
}
