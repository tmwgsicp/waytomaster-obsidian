import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverVaults, install, digest, inspectVault, verifyBundle} from '../installer/install.mjs';

function missing(error) { if (error.code === 'ENOENT') error.name = 'NotFoundError'; return error; }
class Directory {
  constructor(path, control = {}) { this.kind = 'directory'; this.path = path; this.name = path.split(/[\\/]/).at(-1); this.control = control; }
  async *entries() {
    for (const entry of await readdir(this.path, {withFileTypes: true})) {
      yield [entry.name, entry.isDirectory() ? new Directory(join(this.path, entry.name), this.control) : {kind: 'file'}];
    }
  }
  async getDirectoryHandle(name, options = {}) {
    const path = join(this.path, name);
    if (options.create) await mkdir(path, {recursive: true});
    try { if (!(await stat(path)).isDirectory()) throw Error('not a directory'); }
    catch (error) { throw missing(error); }
    return new Directory(path, this.control);
  }
  async getFileHandle(name, options = {}) {
    const path = join(this.path, name), control = this.control;
    try { await stat(path); } catch (error) { if (options.create && error.code === 'ENOENT') await writeFile(path, ''); else throw missing(error); }
    return {
      getFile: async () => new Blob([await readFile(path)]),
      createWritable: async () => {
        let bytes;
        return {
          write: async raw => {
            if (control.fail && path.includes('wechatrss') && name === 'styles.css') { control.fail = false; throw Error('simulated disk failure'); }
            bytes = raw;
          },
          close: async () => { await writeFile(path, bytes); control.writes = (control.writes || 0) + 1; },
          abort: async () => {},
        };
      },
    };
  }
  async removeEntry(name) { await rm(join(this.path, name)); }
}
async function fixture(t, oldVersion = null) {
  const path = await mkdtemp(join(tmpdir(), 'waytomaster-install-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  await mkdir(join(path, '.obsidian'));
  await writeFile(join(path, '我的笔记.md'), '保留我的笔记');
  const target = join(path, '.obsidian', 'plugins', 'wechatrss');
  if (oldVersion) {
    await mkdir(target, {recursive: true});
    await writeFile(join(target, 'manifest.json'), JSON.stringify({id: 'wechatrss', version: oldVersion}));
    await writeFile(join(target, 'main.js'), 'old-main'); await writeFile(join(target, 'styles.css'), 'old-style');
    await writeFile(join(target, 'data.json'), '{"progress":"keep"}');
  }
  const assets = {};
  const bytes = {'main.js': 'new-main', 'styles.css': 'new-style', 'manifest.json': JSON.stringify({id: 'wechatrss', name: 'WaytoMaster', version: '0.2.0', isDesktopOnly: true})};
  for (const [name, raw] of Object.entries(bytes)) assets[name] = {base64: Buffer.from(raw).toString('base64'), sha256: await digest(Buffer.from(raw))};
  return {path, target, vault: new Directory(path), bundle: {version: '0.2.0', assets}};
}
test('first install writes only plugin assets and repeat install is unchanged', async t => {
  const f = await fixture(t);
  assert.equal((await install(f.vault, f.bundle)).action, 'install');
  const writes = f.vault.control.writes;
  assert.equal((await install(f.vault, f.bundle)).action, 'unchanged');
  assert.equal(f.vault.control.writes, writes);
  assert.equal(await readFile(join(f.path, '我的笔记.md'), 'utf8'), '保留我的笔记');
});
test('upgrade preserves state and leaves a recovery snapshot of plugin assets', async t => {
  const f = await fixture(t, '0.1.1'); const result = await install(f.vault, f.bundle);
  assert.equal(result.action, 'upgrade');
  assert.equal(await readFile(join(f.target, 'data.json'), 'utf8'), '{"progress":"keep"}');
  assert.equal(await readFile(join(f.target, '..', result.backup, 'main.js'), 'utf8'), 'old-main');
});
test('partial write failure restores old assets and leaves data intact', async t => {
  const f = await fixture(t, '0.1.1'); f.vault.control.fail = true;
  await assert.rejects(install(f.vault, f.bundle), /已恢复/);
  assert.equal(await readFile(join(f.target, 'main.js'), 'utf8'), 'old-main');
  assert.equal(JSON.parse(await readFile(join(f.target, 'manifest.json'))).version, '0.1.1');
  assert.equal(await readFile(join(f.target, 'styles.css'), 'utf8'), 'old-style');
  assert.equal(await readFile(join(f.target, 'data.json'), 'utf8'), '{"progress":"keep"}');
});
test('checksum failure does not create plugin directory', async t => {
  const f = await fixture(t); f.bundle.assets['main.js'].sha256 = '0'.repeat(64);
  await assert.rejects(install(f.vault, f.bundle), /校验失败/);
  await assert.rejects(stat(f.target), {code: 'ENOENT'});
});
test('wrong directory and newer plugin are not overwritten', async t => {
  const f = await fixture(t, '0.3.0');
  await assert.rejects(install(f.vault, f.bundle), /更新版本/);
  assert.equal(await readFile(join(f.target, 'main.js'), 'utf8'), 'old-main');
  await assert.rejects(inspectVault(new Directory(f.target)), /笔记库/);
});
test('extra payload file and another plugin identity are rejected', async t => {
  const f = await fixture(t, '0.1.1');
  f.bundle.assets['data.json'] = f.bundle.assets['main.js'];
  await assert.rejects(verifyBundle(f.bundle), /不完整/);
  delete f.bundle.assets['data.json'];
  await writeFile(join(f.target, 'manifest.json'), '{"id":"other-plugin"}');
  await assert.rejects(install(f.vault, f.bundle), /其他插件/);
});

async function searchFixture(t, paths) {
  const path = await mkdtemp(join(tmpdir(), 'waytomaster-discovery-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  for (const name of paths) await mkdir(join(path, name, '.obsidian'), {recursive: true});
  await writeFile(join(path, 'private-note.md'), 'Do not read or change');
  return new Directory(path);
}

test('locates nested vaults without reading notes, creating files or changing folders', async t => {
  const root = await searchFixture(t, ['工作/笔记', '个人/笔记', '.hidden/not-a-candidate', 'node_modules/skip']);
  root.getFileHandle = async () => { throw Error('Discovery must not read files'); };
  const found = await discoverVaults(root);
  assert.deepEqual(found.vaults.map(v => v.path.slice(root.name.length+1)).sort(), ['个人/笔记', '工作/笔记']);
  assert.equal(found.limited, false); assert.equal(found.unreadable, 0);
  assert.equal(root.control.writes, undefined);
  assert.equal(await readFile(join(root.path,'private-note.md'),'utf8'), 'Do not read or change');
  for (const item of found.vaults) await assert.rejects(stat(join(item.handle.path,'.obsidian','plugins')), {code:'ENOENT'});
});

test('direct vault selection and a single child both resolve correctly', async t => {
  const f = await fixture(t);
  assert.equal((await discoverVaults(f.vault)).vaults[0].handle, f.vault);
  const parent = await searchFixture(t, ['我的笔记']);
  const found = await discoverVaults(parent);
  assert.equal(found.vaults.length,1);
  assert.equal(found.vaults[0].handle.name,'我的笔记');
  await install(found.vaults[0].handle,f.bundle);
  assert.equal((await inspectVault(found.vaults[0].handle)).existing.version,'0.2.0');
});

test('empty and bounded searches distinguish no results from incomplete results', async t => {
  const empty = await searchFixture(t, []);
  assert.deepEqual(await discoverVaults(empty), {vaults:[],limited:false,unreadable:0});
  const tree = await searchFixture(t, ['a/b/c/deep','other/vault']);
  for (const options of [{maxDepth:1},{maxDirectories:1},{maxEntries:1}]) {
    assert.equal((await discoverVaults(tree,options)).limited,true);
  }
});

test('cancelled search never proceeds to installation', async t => {
  const root = await searchFixture(t,['vault']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverVaults(root,{signal:controller.signal}), {name:'AbortError'});
  assert.equal(root.control.writes,undefined);
});

test('unreadable children do not hide accessible sibling vaults', async t => {
  const root = await searchFixture(t,['available']);
  const available = await root.getDirectoryHandle('available');
  root.entries = async function* () {
    yield ['unreadable',{kind:'directory',getDirectoryHandle:async()=>{throw new DOMException('Denied','NotAllowedError');}}];
    yield ['available',available];
  };
  const result = await discoverVaults(root);
  assert.equal(result.unreadable,1);
  assert.equal(result.vaults[0].handle.name,'available');
});
