import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository, SyncEngine, emptyState, publisherFolder, filterScope } from '../.test-build/sync.mjs';

const filter={directory:'Imported',fakeids:['pub-a','pub-b','../../evil\\path']};
const article=(id,fakeid='pub-a',nickname='我的公众号')=>({id,title:'文章 '+id,account:{fakeid,nickname},
  url:'https://example.invalid/'+id,published_at:1,updated_at:2,body_state:'ready',body:'正文'});
const api=(items,account='account-a')=>({account,page:async()=>({items,next_cursor:'done',has_more:false}),article:async id=>items.find(a=>a.id===id)});
function setup(initial=emptyState()){
 let durable=structuredClone(initial), rejectSave=false, rejectWrite=false;const paths=[];
 const repository=new Repository(structuredClone(initial),async next=>{if(rejectSave&&next.publisherFolders)throw Error('disk full');durable=structuredClone(next);});
 const vault={upsert:async(path,identity,content,previous)=>{if(rejectWrite)throw Error('disk full');paths.push(previous?.path||path);return {kind:'created',path:previous?.path||path,hash:'test-hash'};}};
 return {repository,vault,paths,engine:new SyncEngine(repository,vault,()=>{}),durable:()=>durable,failSave:v=>rejectSave=v,failWrite:v=>rejectWrite=v};
}

test('first publisher name survives persistence/restart and subsequent nickname changes; other accounts stay isolated',async()=>{
 const s=setup();await s.engine.run(api([article(1)]),filter);const first=s.paths[0].split('/').slice(0,-1).join('/');
 const resumed=setup(s.durable());await resumed.engine.run(api([article(2,'pub-a','公众号已改名')]),filter);
 assert.equal(resumed.paths[0].split('/').slice(0,-1).join('/'),first);
 assert.match(first,/我的公众号 · [a-f0-9]{12}$/);
 await resumed.engine.run(api([article(3,'pub-a','另一账号昵称')],'account-b'),filter);
 assert.ok(resumed.paths[1].startsWith('Imported/account-b/另一账号昵称'));
 assert.equal(Object.keys(resumed.durable().publisherFolders).length,2);
});

test('same-name publishers and malicious identifiers cannot mix folders or escape Vault',async()=>{
 const s=setup();await s.engine.run(api([article(1),article(2,'pub-b'),article(3,'../../evil\\path','CON. / <>:#[]^')]),filter);
 assert.notEqual(s.paths[0].split('/')[2],s.paths[1].split('/')[2]);
 for(const path of s.paths){assert.equal(path.split('/').length,4);assert.ok(!path.includes('..'));}
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
