// Builds dist/esm (ESM + .d.ts, CLI included) and dist/cjs (CommonJS + .d.ts) with the TypeScript compiler.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
// src/version.ts follows package.json.
const vfile = path.join(dir, 'src/version.ts');
const vsrc = `// Kept in sync with package.json by scripts/build.mjs.\nexport const VERSION = '${pkg.version}';\n`;
if (readFileSync(vfile, 'utf8') !== vsrc) writeFileSync(vfile, vsrc);

const tsc = createRequire(path.join(dir, 'package.json')).resolve('typescript/bin/tsc');
rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
for (const cfg of ['tsconfig.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [tsc, '-p', path.join(dir, cfg)], { stdio: 'inherit', cwd: dir });
}
// dist/cjs is CommonJS although the package is "type": "module".
writeFileSync(path.join(dir, 'dist/cjs/package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
if (!existsSync(path.join(dir, 'dist/esm/cli/main.js'))) throw new Error('CLI was not built');
console.log(`built @pandafile/sdk ${pkg.version} -> dist/esm, dist/cjs`);
