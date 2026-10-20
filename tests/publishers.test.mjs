import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository, SyncEngine, emptyState, publisherFolder, filterScope, digest, markdown, progressText } from '../.test-build/sync.mjs';
import { fixture, ObsidianVault } from '../.test-build/vault.mjs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const filter={directory:'Imported',fakeids:['pub-a','pub-b','../../evil\\path']};
const article=(id,fakeid='pub-a',nickname='我的公众号')=>({id,title:'文章 '+id,account:{fakeid,nickname},
  url:'https://example.invalid/'+id,published_at:1,updated_at:2,body_state:'ready',body:'正文'});
const api=(items,account='account-a')=>({account,page:async()=>({items,next_cursor:'done',has_more:false}),article:async id=>items.find(a=>a.id===id)});
function setup(initial=emptyState()){
 let durable=structuredClone(initial), rejectSave=false, rejectWrite=false;const paths=[];
 const repository=new Repository(structuredClone(initial),async next=>{if(rejectSave&&next.publisherFolders)throw Error('disk full');durable=structuredClone(next);});
 const vault={exists:path=>paths.some(file=>file.startsWith(path+'/')),moveFolder:async()=>{throw Error('unexpected move');},upsert:async(path,identity,content,previous)=>{if(rejectWrite)throw Error('disk full');paths.push(previous?.path||path);return {kind:'created',path:previous?.path||path,hash:'test-hash'};}};
 return {repository,vault,paths,engine:new SyncEngine(repository,vault,()=>{}),durable:()=>durable,failSave:v=>rejectSave=v,failWrite:v=>rejectWrite=v};
}

test('first publisher name survives persistence/restart and subsequent nickname changes; other accounts stay isolated',async()=>{
 const s=setup();await s.engine.run(api([article(1)]),filter);const first=s.paths[0].split('/').slice(0,-1).join('/');
 const resumed=setup(s.durable());await resumed.engine.run(api([article(2,'pub-a','公众号已改名')]),filter);
 assert.equal(resumed.paths[0].split('/').slice(0,-1).join('/'),first);
 assert.equal(first,'Imported/我的公众号');
 await resumed.engine.run(api([article(3,'pub-a','另一账号昵称')],'account-b'),filter);
 assert.ok(resumed.paths[1].startsWith('Imported/另一账号昵称/'));
 assert.equal(Object.keys(resumed.durable().publisherFolders).length,2);
});

test('same-name publishers and malicious identifiers cannot mix folders or escape Vault',async()=>{
 const s=setup();await s.engine.run(api([article(1),article(2,'pub-b'),article(3,'../../evil\\path','CON. / <>:#[]^')]),filter);
 assert.equal(s.paths[0].split('/')[1],'我的公众号');
 assert.equal(s.paths[1].split('/')[1],'我的公众号（2）');
 for(const path of s.paths){assert.equal(path.split('/').length,3);assert.ok(!path.includes('..'));}
 for(const nickname of ['NUL','COM1',' . ','字😀'.repeat(100),'name. ']){
  const folder=publisherFolder({fakeid:'../bad',nickname});
  assert.doesNotMatch(folder,/[\\/:*?"<>|#\[\]^\u0000-\u001f]/);
  assert.ok(!folder.startsWith('.')&&!folder.endsWith('.')&&!folder.endsWith(' '));assert.ok(Buffer.byteLength(folder)<100);
 }
});

test('mapping save failure writes no article or cursor; note failure after mapping save recovers the first name',async()=>{
 const s=setup();s.failSave(true);
 assert.equal((await s.engine.run(api([article(1)]),filter)).state,'storage');
 assert.equal(s.paths.length,0);assert.equal(s.durable().feeds[filterScope('account-a',filter)].cursor,null);
 s.failSave(false);s.failWrite(true);
 assert.equal((await s.engine.run(api([article(1)]),filter)).state,'storage');
 assert.equal(Object.keys(s.durable().publisherFolders).length,1);
 const resumed=setup(s.durable());await resumed.engine.run(api([article(1,'pub-a','新昵称')]),filter);
 assert.match(resumed.paths[0],/我的公众号/);assert.doesNotMatch(resumed.paths[0],/新昵称/);
});

test('old v1 states retain existing files, cursor and cooldowns while malformed folder mappings fail closed',async()=>{
 const old=emptyState();old.files.old={path:'kept.md',hash:'kept'};old.cooldowns.other=123;old.feeds.other={cursor:'keep',pending:{},pendingCursor:0};
 const s=setup(old);await s.engine.run(api([article(1)]),filter);
 assert.deepEqual(s.durable().files.old,old.files.old);assert.equal(s.durable().feeds.other.cursor,'keep');assert.equal(s.durable().cooldowns.other,123);
 const bad=structuredClone(s.durable());bad.publisherFolders[Object.keys(bad.publisherFolders)[0]]='../escape';
 const blocked=setup(bad);assert.equal((await blocked.engine.run(api([article(2)]),filter)).state,'storage');assert.equal(blocked.paths.length,0);
 const corrupt=setup({...old,publisherFolders:[]});assert.equal((await corrupt.engine.run(api([article(1)]),filter)).state,'storage');assert.equal(corrupt.paths.length,0);
});

async function legacyFixture(t) {
 const root=await mkdtemp(join(tmpdir(),'wechatrss-folder-migration-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const f=fixture(root), port=new ObsidianVault(f.app), state=emptyState();
 const namespace=digest('account-a\nImported'), key=namespace+':pub-a';
 const folder='我的公众号 · '+digest('pub-a').slice(0,12), from='Imported/account-a/'+folder;
 state.publisherFolders={[key]:folder};
 for(const id of [1,2]) {
   const content=markdown(article(id),'account-a',namespace);
   const result=await port.upsert(from+'/'+id+'.md',namespace+':'+id,content);
   state.files[namespace+':'+id]={path:result.path,hash:result.hash};
 }
 const edited=(await f.read(from+'/2.md'))+'\n我的修改'; await f.edit(from+'/2.md',edited);
 let durable=structuredClone(state), rejectFinal=false;
 const repository=new Repository(state,async next=>{
   if(rejectFinal && next.publisherPaths?.[key] && !next.publisherPaths[key].from) throw Error('disk full after move');
   durable=structuredClone(next);
 });
 return {...f,root,port,repository,namespace,key,from,edited,durable:()=>durable,failFinal:value=>rejectFinal=value,
   engine:new SyncEngine(repository,port,()=>{})};
}

test('legacy folders flatten even with no new articles, preserving edits, paths and replay identity',async t=>{
 const f=await legacyFixture(t), before=await f.read(f.from+'/1.md');
 assert.equal((await f.engine.run(api([]),filter)).state,'idle');
 assert.equal(await f.read('Imported/我的公众号/1.md'),before);
 assert.equal(await f.read('Imported/我的公众号/2.md'),f.edited);
 assert.equal(f.app.vault.getAbstractFileByPath('Imported/account-a'),null);
 assert.equal(f.repository.state.files[f.namespace+':1'].path,'Imported/我的公众号/1.md');
 const result=await f.engine.run(api([article(1),{...article(2),body:'新的正文'}]),filter);
 assert.equal(result.conflicts,1);assert.equal(f.app.vault.getMarkdownFiles().length,2);
 assert.equal(await f.read('Imported/我的公众号/2.md'),f.edited);
});

test('rename completed but state save failed resumes the reserved destination after restart',async t=>{
 const f=await legacyFixture(t);f.failFinal(true);
 assert.equal((await f.engine.run(api([]),filter)).state,'storage');
 assert.ok(f.durable().publisherPaths[f.key].from);
 const resumed=new Repository(f.durable(),async()=>{});
 assert.equal((await new SyncEngine(resumed,new ObsidianVault(f.app),()=>{}).run(api([]),filter)).state,'idle');
 assert.equal(resumed.state.publisherPaths[f.key].path,'Imported/我的公众号');
 assert.equal(resumed.state.publisherPaths[f.key].from,undefined);
 assert.equal(resumed.state.files[f.namespace+':2'].path,'Imported/我的公众号/2.md');
 assert.equal(await f.read('Imported/我的公众号/2.md'),f.edited);
 assert.equal(f.app.vault.getMarkdownFiles().length,2);
});

test('occupied folder and case-insensitive names are separated without merging user notes',async t=>{
 const f=await legacyFixture(t);
 await f.app.vault.createFolder('Imported/我的公众号');await f.app.vault.create('Imported/我的公众号/私人笔记.md','keep');
 await f.engine.run(api([]),filter);
 assert.equal(f.repository.state.publisherPaths[f.key].path,'Imported/我的公众号（2）');
 assert.equal(await f.read('Imported/我的公众号/私人笔记.md'),'keep');
 await f.engine.run(api([article(3,'pub-b','YOUCORER')]),filter);
 await f.engine.run(api([article(4,'pub-b','youcorer')],'account-b'),filter);
 assert.ok(f.app.vault.getAbstractFileByPath('Imported/YOUCORER'));
 assert.ok(f.app.vault.getAbstractFileByPath('Imported/youcorer（2）'));
});

test('failed rename and a foreign account note leave source and cursor intact',async t=>{
 const f=await legacyFixture(t), before=await f.read(f.from+'/1.md');
 const original=f.app.fileManager.renameFile;f.app.fileManager.renameFile=async()=>{throw Error('locked');};
 assert.equal((await f.engine.run(api([]),filter)).state,'storage');
 assert.equal(await f.read(f.from+'/1.md'),before);
 assert.equal(f.repository.state.feeds[filterScope('account-a',filter)].cursor,null);
 f.app.fileManager.renameFile=original;
 await f.app.vault.create(f.from+'/other.md',markdown(article(9),'other-account','other-namespace'));
 assert.equal((await f.engine.run(api([]),filter)).state,'storage');
 assert.equal(await f.read(f.from+'/1.md'),before);
 assert.equal(f.app.vault.getAbstractFileByPath('Imported/我的公众号'),null);
});

test('status text distinguishes normal completion, missing bodies, lost access and preserved local edits',()=>{
 const base={state:'idle',message:'已检查，没有新增或更新',processed:0,pending:0,conflicts:0};
 assert.equal(progressText(base,true),base.message);
 const waiting=progressText({...base,pending:6},true);
 assert.match(waiting,/6 篇正文待补，下次同步会重试/);assert.doesNotMatch(waiting,/编辑|修改/);
 const edited=progressText({...base,conflicts:2},true);
 assert.match(edited,/已保留 2 篇本地修改/);assert.doesNotMatch(edited,/正文待补/);
 assert.match(progressText({...base,blocked:1},true),/在 WeChatRSS 检查/);
 assert.match(progressText({...base,unavailable:1},true),/正文暂不可用/);
});

test('hidden files in the old account directory survive cleanup and do not block sync',async t=>{
 const f=await legacyFixture(t), hidden=join(f.root,'Imported/account-a/.DS_Store');
 await writeFile(hidden,'keep hidden metadata');
 assert.equal((await f.engine.run(api([]),filter)).state,'idle');
 assert.equal(await readFile(hidden,'utf8'),'keep hidden metadata');
 assert.equal(await f.read('Imported/我的公众号/2.md'),f.edited);
 assert.equal(f.repository.state.publisherPaths[f.key].from,undefined);
});
