// Bundle each tests/*.test.ts (with its imports inlined) into .test-out/*.test.mjs
// so Node's built-in test runner can execute them without a TypeScript toolchain.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const testDir = 'tests';
const entryPoints = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(testDir, f));

if (entryPoints.length === 0) {
  console.error('No test files found in tests/');
  process.exit(1);
}

esbuild
  .build({
    entryPoints,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    outdir: '.test-out',
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  })
  .catch(() => process.exit(1));
