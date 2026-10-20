import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository, SyncEngine, emptyState, digest, filterScope, accountScope, SyncError } from '../.test-build/sync.mjs';

const filter = { fakeids: ['pub'], directory: 'Imported' };
const article = (id, extra = {}) => ({ id, account: { fakeid: 'pub', nickname: 'Publisher' }, title: `Article ${id}`,
  url: `https://mp.weixin.qq.com/s/${id}`, published_at: 100, updated_at: 200, body_state: 'ready', body: `Body ${id}`,
  publication_mode: 'mass_notification', native_publish_type: 9, publication_type_source: 'native_list', publication_observed_at: 200, ...extra });
const apiOf = (items, extra = {}) => ({ account: 'account-a', async page() { return { items, next_cursor: 'c1', has_more: false }; },
  async article(id) { return article(id); }, ...extra });
function setup(initial = emptyState()) {
  let durable = structuredClone(initial), failPersist = false;
  const repository = new Repository(structuredClone(initial), async next => {
    if (failPersist) throw new Error('disk full');
    durable = structuredClone(next);
  });
  const files = new Map(), writes = [];
  const vault = { exists: path => [...files.keys()].some(file => file === path || file.startsWith(path + '/')), async moveFolder() { throw Error('unexpected legacy move'); }, async upsert(path, identity, content, previous) {
    const current = files.get(previous?.path || path);
    if (current !== undefined && current !== content && (!previous || digest(current) !== previous.hash))
      return { kind:'conflict', path, hash:digest(current) };
    const kind = current === undefined ? 'created' : current === content ? 'unchanged' : 'updated';
    const actualPath = previous?.path || path;
    files.set(actualPath, content); if (kind !== 'unchanged') writes.push(actualPath);
    return { kind, path:actualPath, hash:digest(content) };
  } };
  const statuses = [], engine = new SyncEngine(repository, vault, status => statuses.push(status), () => 1000);
  return { repository, engine, vault, files, writes, statuses, durable: () => durable, failPersist: value => { failPersist = value; } };
}

test('stable IDs deduplicate replay and overlapping filters; different accounts never share files or cursors', async () => {
  const s = setup();
  await s.engine.run(apiOf([article(1)]), filter);
  await s.engine.run(apiOf([article(1)]), filter);
  await s.engine.run(apiOf([article(1)]), { ...filter, publishedAfter: 50 });
  assert.equal(s.files.size, 1); assert.equal(s.writes.length, 1);
  const cursors = [];
  await s.engine.run(apiOf([article(1)], { account:'account-b', async page(_, cursor) {
    cursors.push(cursor); return { items:[article(1)], next_cursor:'b1', has_more:false };
  } }), filter);
  assert.deepEqual(cursors,[null]); assert.equal(s.files.size,2);
  assert.notEqual(accountScope({ endpoint:'https://one.example',key:'key-a' }),accountScope({ endpoint:'https://two.example',key:'key-a' }));
  assert.notEqual(accountScope({ endpoint:'https://one.example',key:'key-a' }),accountScope({ endpoint:'https://one.example',key:'key-b' }));
});

test('a page failure retains cursor and replay does not duplicate already durable articles', async () => {
  const s = setup(), original = s.vault.upsert;
  s.vault.upsert = async (...args) => { if (args[1].endsWith(':2')) throw new Error('disk full'); return original(...args); };
  assert.equal((await s.engine.run(apiOf([article(1), article(2)]),filter)).state,'storage');
  const key = filterScope('account-a',filter);
  assert.equal(s.durable().feeds[key].cursor,null); assert.equal(s.files.size,1);
  s.vault.upsert = original;
  await s.engine.run(apiOf([article(1),article(2)]),filter);
  assert.equal(s.files.size,2); assert.equal(s.writes.length,2); assert.equal(s.durable().feeds[key].cursor,'c1');
});

test('persistence failure after file write cannot advance checkpoint; restart recovers identical file safely', async () => {
  const s = setup(), original = s.vault.upsert;
  s.vault.upsert = async (...args) => { const result = await original(...args); s.failPersist(true); return result; };
  assert.equal((await s.engine.run(apiOf([article(1)]),filter)).state,'storage');
  assert.equal(s.durable().feeds[filterScope('account-a',filter)].cursor,null);
  const repository = new Repository(s.durable(), async () => {});
  const restarted = new SyncEngine(repository,{...s.vault,upsert:original},()=>{});
  await restarted.run(apiOf([article(1)]),filter);
  assert.equal(s.writes.length,1); assert.equal(repository.state.feeds[filterScope('account-a',filter)].cursor,'c1');
});

test('pending and ready-without-markdown are checkpointed as pending and old articles can be filled later', async () => {
  const s=setup();
  await s.engine.run(apiOf([article(1,{body_state:'pending',body:null}),article(2,{body:null})]),filter);
  assert.equal(s.statuses.at(-1).pending,2);
  assert.match([...s.files.values()][1],/正文待补齐/);
  const requested=[];
  await s.engine.run(apiOf([], {async article(id){requested.push(id);return article(id,{updated_at:300});}}),filter);
  assert.deepEqual(requested,[1,2]); assert.equal(s.statuses.at(-1).pending,0);
  assert.equal(s.files.size,2); assert.ok([...s.files.values()].every(body=>body.includes('Body')));
});

test('edited file remains byte-identical, conflict persists across page checkpoint', async () => {
  const s=setup();await s.engine.run(apiOf([article(1)]),filter);
  const path=[...s.files.keys()][0], edited=s.files.get(path)+'\nMy personal notes';
  s.files.set(path,edited);
  const result=await s.engine.run(apiOf([article(1,{body:'Updated source',updated_at:300})]),filter);
  assert.equal(s.files.get(path),edited);assert.equal(result.conflicts,1);
  assert.equal(s.durable().feeds[filterScope('account-a',filter)].cursor,'c1');
});

test('pause during a request prevents writes and does not advance cursor', async () => {
  const s=setup();let finish;
  const running=s.engine.run(apiOf([], {page:()=>new Promise(resolve=>{finish=resolve;})}),filter);
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  s.engine.pause();finish({items:[article(1)],next_cursor:'c1',has_more:false});
  assert.equal((await running).state,'paused');assert.equal(s.files.size,0);
  assert.equal(s.durable().feeds[filterScope('account-a',filter)].cursor,null);
});

test('401 is explicit, 429 persists account-wide cooldown across filters and restart', async () => {
  const s=setup();
  assert.equal((await s.engine.run(apiOf([], {async page(){throw new SyncError('authentication','revoked');}}),filter)).state,'authentication');
  assert.equal((await s.engine.run(apiOf([], {async page(){throw new SyncError('rate_limit','wait',10000);}}),filter)).state,'rate_limit');
  const s2=setup(s.durable());let called=false;
  const result=await s2.engine.run(apiOf([], {async page(){called=true;throw new Error();}}),{...filter,publishedAfter:1});
  assert.equal(result.state,'rate_limit');assert.equal(called,false);
});

test('pending retry rotates and forbidden items remain tracked without buying access', async()=>{
  const s=setup();await s.engine.run(apiOf(Array.from({length:12},(_,i)=>article(i+1,{body_state:'pending',body:null}))),filter);
  const ids=[];
  const api=apiOf([], {async article(id){ids.push(id);if(id===1)throw new SyncError('not_found','denied');return article(id,{body_state:'pending',body:null});}});
  await s.engine.run(api,filter);await s.engine.run(api,filter);
  assert.deepEqual(ids.slice(0,12),Array.from({length:12},(_,i)=>i+1));
  assert.equal(s.durable().feeds[filterScope('account-a',filter)].pending['1'],'blocked');
});

test('server wrong publisher or repeated nonterminal cursor does not silently move checkpoint',async()=>{
  const s=setup();
  assert.equal((await s.engine.run(apiOf([article(1,{account:{fakeid:'other',nickname:'Other'}})]),filter)).state,'response');
  assert.equal(s.files.size,0);
  await s.engine.run(apiOf([]),filter);
  assert.equal((await s.engine.run(apiOf([], {async page(){return{items:[],next_cursor:'c1',has_more:true};}}),filter)).state,'response');
});

test('manual work is bounded to 20 pages and no API credentials enter Markdown or sync state',async()=>{
  const s=setup();let pages=0;
  const api=apiOf([], {async page(){pages++;return {items:[article(pages)],next_cursor:String(pages),has_more:true};}});
  assert.equal((await s.engine.run(api,filter)).state,'page_limit');assert.equal(pages,20);
  assert.equal(s.durable().feeds[filterScope('account-a',filter)].cursor,'20');
  assert.equal((await s.engine.run(api,filter)).state,'page_limit');assert.equal(pages,40);
  assert.equal(s.durable().feeds[filterScope('account-a',filter)].cursor,'40');
  assert.doesNotMatch(JSON.stringify(s.durable()),/X-API|secret|token/i);
});
