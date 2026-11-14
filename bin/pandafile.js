#!/usr/bin/env node
// The pandafile CLI (compiled from src/cli/). Node 18+.
import('../dist/esm/cli/main.js').then((m) => m.main(process.argv.slice(2))).then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => { console.error(err?.stack || err); process.exitCode = 1; },
);
