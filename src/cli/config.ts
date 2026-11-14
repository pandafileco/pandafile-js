// Where the CLI keeps its key and resumable send state:
//   macOS   ~/Library/Application Support/pandafile/
//   Linux   $XDG_CONFIG_HOME/pandafile/ (default ~/.config/pandafile/)
//   Windows %APPDATA%\pandafile\
// PANDAFILE_CONFIG_DIR overrides it. The directory is 0700 and config.json 0600 (owner only).
import { mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface CliConfig {
  live_key?: string;
  test_key?: string;
  base_url?: string;
  email?: string;
}

export function configDir(): string {
  if (process.env.PANDAFILE_CONFIG_DIR) return path.resolve(process.env.PANDAFILE_CONFIG_DIR);
  const home = homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'pandafile');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'pandafile');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'pandafile');
}

export const configFile = () => path.join(configDir(), 'config.json');

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows */ }
}

export function readConfig(): CliConfig {
  try { return JSON.parse(readFileSync(configFile(), 'utf8')) as CliConfig; } catch { return {}; }
}

export function writeConfig(cfg: CliConfig): string {
  ensureDir(configDir());
  const file = configFile();
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
  return file;
}

// ---------- resumable sends ----------
const stateDir = () => path.join(configDir(), 'uploads');

export function readState<T>(id: string): T | null {
  try { return JSON.parse(readFileSync(path.join(stateDir(), id + '.json'), 'utf8')) as T; } catch { return null; }
}
export function writeState(id: string, state: unknown): void {
  ensureDir(stateDir());
  const file = path.join(stateDir(), id + '.json');
  writeFileSync(file, JSON.stringify(state) + '\n', { mode: 0o600 }); // holds the transfer's owner token
}
export function removeState(id: string): void {
  rmSync(path.join(stateDir(), id + '.json'), { force: true });
}
// Unfinished sends are kept for 2 days (tus uploads on the server do not live longer than the transfer anyway).
export function pruneStates(maxAgeMs = 2 * 86400e3): void {
  try {
    for (const f of readdirSync(stateDir())) {
      const p = path.join(stateDir(), f);
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { force: true });
    }
  } catch { /* none yet */ }
}
