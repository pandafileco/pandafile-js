// A one-line progress bar on stderr: bar, percent, bytes, speed, ETA and files done. Plain lines when stderr is no TTY.
import type { SendProgress } from '../send.js';
import { formatBytes } from '../util.js';

export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

export class ProgressBar {
  private last = 0;
  private speed = 0;
  private sampleAt = 0;
  private sampleBytes = 0;
  private startBytes: number | null = null;
  private drawn = false;
  private readonly tty: boolean;
  private readonly finished = new Set<string>();

  constructor(private readonly out: NodeJS.WriteStream = process.stderr, private readonly quiet = false) {
    this.tty = !!out.isTTY && !process.env.CI;
  }

  update(p: SendProgress): void {
    if (this.quiet) return;
    const now = Date.now();
    if (p.phase === 'uploading' && this.startBytes === null) { this.startBytes = p.bytesUploaded; this.sampleAt = now; this.sampleBytes = p.bytesUploaded; }
    if (now - this.sampleAt >= 500 && this.startBytes !== null) {
      const inst = (p.bytesUploaded - this.sampleBytes) / ((now - this.sampleAt) / 1000);
      this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst;
      this.sampleAt = now; this.sampleBytes = p.bytesUploaded;
    }
    if (!this.tty) {
      // Logs: one line per finished file.
      if (p.file && p.file.bytesUploaded >= p.file.bytesTotal && !this.finished.has(p.file.name)) {
        this.finished.add(p.file.name);
        this.out.write(`uploaded ${p.file.name} (${formatBytes(p.file.bytesTotal)}) [${p.filesDone}/${p.filesTotal}]\n`);
      }
      return;
    }
    if (now - this.last < 80 && p.phase === 'uploading' && p.bytesUploaded < p.bytesTotal) return;
    this.last = now;
    const cols = Math.max(40, this.out.columns || 80);
    const pct = `${Math.floor(p.percent).toString().padStart(3)}%`;
    const left = p.bytesTotal - p.bytesUploaded;
    const tail = p.phase === 'creating' ? 'creating transfer…'
      : p.phase === 'completing' ? 'finishing…'
      : `${formatBytes(p.bytesUploaded)} / ${formatBytes(p.bytesTotal)}  ${this.speed > 0 ? formatBytes(this.speed) + '/s' : ''}  ${this.speed > 0 ? 'ETA ' + duration(left / this.speed) : ''}  ${p.filesDone}/${p.filesTotal} files`;
    const width = Math.max(10, Math.min(40, cols - tail.length - 10));
    const filled = Math.round((p.percent / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const line = ` ${bar} ${pct}  ${tail.replace(/\s+$/, '')}`;
    this.out.write('\r\x1b[2K' + line.slice(0, cols - 1));
    this.drawn = true;
  }

  done(): void {
    if (this.drawn) { this.out.write('\r\x1b[2K'); this.drawn = false; }
  }
}
