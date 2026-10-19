import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, ObsidianVault, digest } from '../.test-build/vault.mjs';
const body=(id,text)=>`---\nwechatrss_namespace: "scope"\nwechatrss_id: ${id}\n---\n${text}`;
async function setup(t){ const root=await mkdtemp(join(tmpdir(),'wechatrss-obsidian-test-')); t.after(()=>rm(root,{recursive:true,force:true})); const f=fixture(root); return {...f, port:new ObsidianVault(f.app)}; }

test('actual adapter creates once, updates unedited placeholders and scans metadata only once',async t=>{
  const f=await setup(t), first=await f.port.upsert('Notes/1.md','scope:1',body(1,'pending'));
  assert.equal(first.kind,'created');
  assert.equal((await f.port.upsert('Notes/1.md','scope:1',body(1,'pending'),first)).kind,'unchanged');
  assert.equal((await f.port.upsert('Notes/1.md','scope:1',body(1,'ready'),first)).kind,'updated');
  await f.port.upsert('Notes/2.md','scope:2',body(2,'ready'));
  assert.equal(f.state.scans,1); assert.equal(await f.read('Notes/1.md'),body(1,'ready'));
});
test('actual atomic process protects edited, concurrently edited and active notes',async t=>{
  const f=await setup(t), first=await f.port.upsert('Notes/1.md','scope:1',body(1,'pending'));
  await f.edit(first.path,'user edit');
  assert.equal((await f.port.upsert(first.path,'scope:1',body(1,'ready'),first)).kind,'conflict');
  assert.equal(await f.read(first.path),'user edit');
  await f.edit(first.path,body(1,'pending'));
  f.state.beforeProcess=()=>f.edit(first.path,'racing edit');
  assert.equal((await f.port.upsert(first.path,'scope:1',body(1,'ready'),first)).kind,'conflict');
  assert.equal(await f.read(first.path),'racing edit');
  await f.edit(first.path,body(1,'pending')); f.state.active=f.app.vault.getAbstractFileByPath(first.path);
  assert.equal((await f.port.upsert(first.path,'scope:1',body(1,'ready'),first)).kind,'conflict');
  assert.equal(digest(await f.read(first.path)),first.hash);
});
test('rename across restart is resolved by stable metadata without duplicate notes',async t=>{
  const f=await setup(t), first=await f.port.upsert('Notes/1.md','scope:1',body(1,'pending'));
  await f.move(first.path,'Notes/renamed.md');
  const restarted=new ObsidianVault(f.app);
  const next=await restarted.upsert(first.path,'scope:1',body(1,'ready'),first);
  assert.equal(next.kind,'updated'); assert.equal(next.path,'Notes/renamed.md');
  assert.equal(f.app.vault.getAbstractFileByPath(first.path),null);
});
test('ambiguous identity and occupied folder fail without overwriting user data',async t=>{
  const f=await setup(t); await f.app.vault.createFolder('Notes');
  await f.app.vault.create('Notes/a.md',body(1,'a')); await f.app.vault.create('Notes/b.md',body(1,'b'));
  await assert.rejects(f.port.upsert('Notes/1.md','scope:1',body(1,'ready')),/ambiguous/);
  await f.app.vault.create('occupied','private');
  await assert.rejects(f.port.upsert('occupied/2.md','scope:2',body(2,'ready')),/folder_path_occupied/);
  assert.equal(await f.read('occupied'),'private');
});
