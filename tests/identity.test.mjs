import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArticleApi } from '../.test-build/api.mjs';
import { Repository, SyncEngine, bindReaderIdentity, knownAccountScope, emptyState, filterScope } from '../.test-build/sync.mjs';
import { fixture, ObsidianVault } from '../.test-build/vault.mjs';

const filter = { directory: 'Imported', fakeids: ['publisher'] };
const row = (id, body = 'body', body_state = 'ready') => ({ id, title: 'Title', account: { fakeid: 'publisher', nickname: 'Publisher' },
  url: 'https://example.invalid/article', published_at: 1, updated_at: 2, body_state, body });
function api(key, { subject = 'local:1', endpoint = 'https://example.invalid', status = 200, items = [], calls = [] } = {}) {
  return new ArticleApi({ endpoint, key, secret: 'fixture-secret' }, async url => {
    calls.push(url);
    return { status: url.endsWith('/me') ? status : 200, headers: {}, json: url.endsWith('/me') ? { subject, display_name: 'Same display name' }
      : url.includes('/articles?') ? { items, next_cursor: 'server-cursor', has_more: false }
      : row(Number(new URL(url).pathname.split('/').at(-1)), 'completed') };
  });
}
async function connect(repository, client) {
  const identity = await client.identity();
  client.useAccountScope(await bindReaderIdentity(repository, client.credentialScope, identity));
  return client;
}

test('verified Key rotation resumes old cursor, pending body, renamed/edited notes and publisher mapping without moving files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechatrss-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(root); let durable = emptyState();
  const repository = new Repository(emptyState(), async next => { durable = structuredClone(next); });
  const old = api('old-key', { items: [row(1, null, 'pending'), row(2)] });
  await new SyncEngine(repository, new ObsidianVault(f.app), () => {}).run(old, filter);
  const records = Object.values(repository.state.files), pending = records.find(record => record.path.endsWith('1.md'));
  const edited = records.find(record => record.path.endsWith('2.md'));
  const renamed = pending.path.replace('Title', 'User name');
  await f.move(pending.path, renamed);
  await f.edit(edited.path, (await f.read(edited.path)) + 'USER EDIT');
  const stateBeforeBinding = structuredClone(repository.state);
  await connect(repository, old);
  assert.deepEqual(repository.state.files, stateBeforeBinding.files);
  assert.deepEqual(repository.state.feeds, stateBeforeBinding.feeds);
  const restart = new Repository(structuredClone(durable), async next => { durable = structuredClone(next); });
  const calls = [], rotated = await connect(restart, api('new-key', { items: [row(2)], calls }));
  assert.equal(rotated.account, old.account);
  const progress = await new SyncEngine(restart, new ObsidianVault(f.app), () => {}).run(rotated, filter);
  assert.equal(progress.conflicts, 1);
  assert.ok(await f.read(renamed).then(text => text.includes('completed')));
  assert.ok(await f.read(edited.path).then(text => text.endsWith('USER EDIT')));
  assert.equal(f.app.vault.getMarkdownFiles().length, 2);
  assert.ok(calls.some(url => url.includes('cursor=server-cursor')));
  assert.deepEqual(restart.state.publisherFolders, stateBeforeBinding.publisherFolders);
  assert.equal(restart.state.feeds[filterScope(old.account, filter)].cursor, 'server-cursor');
  assert.ok(!JSON.stringify(durable).includes('old-key') && !JSON.stringify(durable).includes('fixture-secret'));
});

test('same nickname across subjects or hosts cannot share ranges; a known Key changing subject is blocked', async () => {
  const repository = new Repository(emptyState(), async () => {});
  const first = await connect(repository, api('same-key'));
  const other = await connect(repository, api('other-key', { subject: 'local:2' }));
  const host = await connect(repository, api('same-key', { endpoint: 'https://second.invalid' }));
  assert.notEqual(first.account, other.account); assert.notEqual(first.account, host.account);
  const before = structuredClone(repository.state);
  await assert.rejects(connect(repository, api('same-key', { subject: 'local:2' })), error => error.code === 'identity');
  assert.deepEqual(repository.state, before);
});

test('only 404 enables legacy compatibility; already verified ranges cannot silently downgrade', async () => {
  const repository = new Repository(emptyState(), async () => {});
  const old = api('old-service', { status: 404 });
  assert.equal(await old.identity(), null);
  assert.equal((await connect(repository, old)).account, old.credentialScope);
  assert.equal(repository.state.identities, undefined);
  for (const status of [401, 403, 429, 503]) await assert.rejects(api('key', { status }).identity());
  for (const subject of ['', 'email@example.invalid', 'local:0', 'local:../one'])
    await assert.rejects(api('key', { subject }).identity(), error => error.code === 'response');
  await connect(repository, api('old-service'));
  await assert.rejects(connect(repository, old), error => error.code === 'identity');
});

test('binding persistence failure leaves old state intact; rotation preserves maximum cooldown and unrelated old histories', async () => {
  const client = api('old-key'), identity = await client.identity();
  const failing = new Repository(emptyState(), async () => { throw Error('disk full'); });
  await assert.rejects(bindReaderIdentity(failing, client.credentialScope, identity), /disk full/);
  assert.deepEqual(failing.state, emptyState());
  const repository = new Repository(emptyState(), async () => {});
  await connect(repository, client);
  const rotated = api('new-key');
  repository.state.cooldowns[client.account] = 100;
  repository.state.cooldowns[rotated.account] = 200;
  repository.state.feeds[filterScope(rotated.account, filter)] = { cursor: 'separate-old', pending: {}, pendingCursor: 0 };
  const preserved = structuredClone(repository.state.feeds);
  await connect(repository, rotated);
  assert.equal(repository.state.cooldowns[client.account], 200);
  assert.equal(knownAccountScope(repository.state, rotated.credentialScope), client.account);
  assert.deepEqual(repository.state.feeds, preserved);
  for (const identities of [null, [], { accounts: {}, credentials: { bad: 'bad' } }])
    assert.throws(() => knownAccountScope({ ...emptyState(), identities }, client.account), error => error.code === 'storage');
});
