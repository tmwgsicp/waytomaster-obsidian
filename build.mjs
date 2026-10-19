import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const test = process.argv[2] === 'test';
await build({ entryPoints: [test ? 'src/sync.ts' : 'src/main.ts'], bundle: true,
  platform: 'node', format: test ? 'esm' : 'cjs', target: 'es2022',
  external: ['obsidian', 'electron'], outfile: test ? '.test-build/sync.mjs' : 'dist/main.js' });
if (test) {
  await build({ entryPoints: ['src/schedule.ts'], bundle: true, platform: 'node', format: 'esm',
    target: 'es2022', outfile: '.test-build/schedule.mjs' });
  await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'esm',
    alias: { obsidian: './tests/obsidian-stub.ts' }, target: 'es2022', outfile: '.test-build/main.mjs' });
  await build({ entryPoints: ['src/api.ts'], bundle: true, platform: 'node', format: 'esm',
    target: 'es2022', outfile: '.test-build/api.mjs' });
  await build({ entryPoints: ['tests/vault-fixture.ts'], bundle: true, platform: 'node', format: 'esm',
    alias: { obsidian: './tests/obsidian-stub.ts' }, target: 'es2022', outfile: '.test-build/vault.mjs' });
} else {
  await mkdir('dist', { recursive: true });
  for (const file of ['manifest.json', 'styles.css']) await copyFile(file, `dist/${file}`);
}
