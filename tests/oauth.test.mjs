import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthSession, SECRET_ID, ISSUER, SCOPE } from '../.test-build/oauth.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function fixture() {
  const store = new Map(), calls = [];
  let count = 0, failRefresh = false, pause;
  const fetcher = async (url, options) => {
    calls.push({ url, body: options.body?.toString() });
    if (url.endsWith('/register')) return json({ client_id: 'fixture-public-client-123456789', scope: SCOPE }, 201);
    if (url.endsWith('/revoke')) return json({});
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('client_secret'), null);
    if (body.get('grant_type') === 'authorization_code') {
      assert.equal(body.get('redirect_uri'), 'obsidian://waytomaster-oauth');
      assert.equal(body.get('resource'), 'https://wechatrss.waytomaster.com/api');
      assert.ok(body.get('code_verifier').length >= 43);
      if (pause) await pause;
    } else {
      assert.equal(body.get('grant_type'), 'refresh_token');
      if (pause) await pause;
      if (failRefresh) throw new Error('connection lost after server rotated');
    }
    return json({ access_token: 'fixture-access-' + ++count, refresh_token: 'fixture-refresh-' + count,
      token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
  };
  let now = 1000;
  const secrets = { getSecret: id => store.get(id) || null, setSecret: (id, value) => store.set(id, value) };
  const session = new OAuthSession(secrets, fetcher, () => now);
  return { session, store, calls, secrets, fetcher, expire: () => { now += 3600000; }, fail: () => { failRefresh = true; },
    block: promise => { pause = promise; } };
}
async function connect(f) {
  const url = new URL(await f.session.begin());
  assert.equal(url.origin, 'https://wechatrss.waytomaster.com');
  assert.equal(url.pathname, '/connect/obsidian');
  assert.equal(url.searchParams.get('code_challenge').length, 43);
  await f.session.complete({ code: 'fixture-code', state: url.searchParams.get('state') });
}
test('browser authorization uses PKCE and stores refresh grant only in secret storage', async () => {
  const f = fixture(); await connect(f);
  assert.match(await f.session.token(), /^fixture-access/);
  const saved = f.store.get(SECRET_ID);
  assert.match(saved, /fixture-refresh/); assert.doesNotMatch(saved, /fixture-access|verifier/);
  assert.ok(f.calls.every(c => c.url.startsWith(ISSUER)));
});
test('wrong state and cancelled callbacks cannot exchange codes', async () => {
  const f = fixture(), url = new URL(await f.session.begin());
  await assert.rejects(f.session.complete({ code: 'bad', state: 'wrong' }));
  assert.equal(f.calls.length, 1);
  f.session.cancel();
  await assert.rejects(f.session.complete({ code: 'bad', state: url.searchParams.get('state') }));
  assert.equal(f.calls.length, 1);
});
test('restored authorization rotates once for concurrent readers', async () => {
  const f = fixture(); await connect(f);
  const restored = new OAuthSession(f.secrets, f.fetcher);
  assert.equal(restored.restore(), true);
  const tokens = await Promise.all([restored.token(), restored.token(), restored.token()]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(f.calls.filter(c => c.body?.includes('grant_type=refresh_token')).length, 1);
});
test('ambiguous refresh failures clear the consumed token and require reconnect', async () => {
  const f = fixture(); await connect(f); f.expire(); f.fail();
  await assert.rejects(f.session.token(), /重新连接/);
  assert.equal(f.store.get(SECRET_ID), '');
  await assert.rejects(f.session.token());
  assert.equal(f.calls.filter(c => c.body?.includes('grant_type=refresh_token')).length, 1);
});
test('disconnect clears secrets and revokes without deleting note state', async () => {
  const f = fixture(); await connect(f);
  assert.equal(await f.session.disconnect(), true);
  assert.equal(f.store.get(SECRET_ID), '');
  assert.equal(f.session.clientId, '');
  assert.ok(f.calls.at(-1).url.endsWith('/revoke'));
});
test('disconnect during refresh cannot restore the old connection', async () => {
  const f = fixture(); await connect(f); f.expire(); let release;
  f.block(new Promise(resolve => { release = resolve; }));
  const refresh = f.session.token();
  await f.session.disconnect(); release();
  await assert.rejects(refresh);
  assert.equal(f.store.get(SECRET_ID), '');
  assert.equal(f.session.clientId, '');
});

test('cancellation while exchanging a code revokes the late grant', async () => {
  const f = fixture(), url = new URL(await f.session.begin()); let release;
  f.block(new Promise(resolve => { release = resolve; }));
  const completion = f.session.complete({ code: 'fixture-code', state: url.searchParams.get('state') });
  f.session.cancel(); release();
  await assert.rejects(completion, /已取消/);
  assert.ok(f.calls.at(-1).url.endsWith('/revoke'));
  assert.equal(f.session.clientId, '');
  assert.equal(f.store.get(SECRET_ID), undefined);
});
