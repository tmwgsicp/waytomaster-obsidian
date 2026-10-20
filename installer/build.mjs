import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const files = ['main.js', 'manifest.json', 'styles.css'];
const assets = {};
for (const name of files) {
  const raw = await readFile(new URL('../dist/' + name, import.meta.url));
  assets[name] = {base64: raw.toString('base64'), sha256: createHash('sha256').update(raw).digest('hex')};
}
const info = JSON.parse(Buffer.from(assets['manifest.json'].base64, 'base64'));
const script = await build({entryPoints: ['installer/ui.mjs'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022'});
const template = await readFile('installer/index.html', 'utf8');
const html = template.replace('__BUNDLE__', JSON.stringify({version: info.version, assets}).replaceAll('<', '\\u003c')).replace('__SCRIPT__', script.outputFiles[0].text);
await writeFile('dist/WaytoMaster-Obsidian-Install.html', html);
console.log('Created browser installer for ' + info.version);
