import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSchedule } from '../.test-build/schedule.mjs';
import { Repository, SyncEngine, SyncError, emptyState, digest } from '../.test-build/sync.mjs';
import Plugin from '../.test-build/main.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (state = 'idle', retryAt = 0) => ({ state, retryAt, message: state, processed: 0, pending: 0, conflicts: 0 });

test('default clock cancels browser timers without rebinding their receiver', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let cancelled = false;
  globalThis.setTimeout = () => 42;
  globalThis.clearTimeout = function (timer) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(timer, 42);
    cancelled = true;
  };
  try {
    const { SyncSchedule: BrowserSchedule } = await import('../.test-build/schedule.mjs?browser-timer');
    const schedule = new BrowserSchedule(() => {});
    schedule.start(60, async () => result());
    schedule.stop();
    assert.equal(cancelled, true);
    assert.equal(schedule.enabled, false);
    assert.equal(schedule.nextAt, 0);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return { timers, now: () => now,
    set(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; },
    clear(id) { timers.delete(id); },
    async advance(milliseconds) {
      now += milliseconds;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [key, timer] of due) { timers.delete(key); timer.callback(); }
      await flush();
    },
  };
}

test('explicit opt-in, single flight, no catch-up burst after device sleeps', async () => {
  const clock = fakeClock(), schedule = new SyncSchedule(() => {}, clock);
  let calls = 0, finish;
  await clock.advance(3_600_000); assert.equal(calls, 0);
  schedule.start(15, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  await clock.advance(0); assert.equal(calls, 1);
  await clock.advance(86_400_000); assert.equal(calls, 1); assert.equal(clock.timers.size, 0);
  finish(result()); await flush(); assert.equal(clock.timers.size, 1);
  await clock.advance(900_000); assert.equal(calls, 2);
  schedule.stop(); finish(result()); await flush(); assert.equal(clock.timers.size, 0);
});

test('network errors retry at interval, 429 honors longer wait, fatal errors stop', async () => {
  for (const state of ['network', 'server', 'busy', 'page_limit', 'rate_limit']) {
    const clock = fakeClock(), schedule = new SyncSchedule(() => {}, clock); let calls = 0;
    schedule.start(15, async () => { calls++; return result(state, state === 'rate_limit' ? 3_600_000 : 0); });
    await clock.advance(0); assert.equal(calls, 1);
    await clock.advance(899_999); assert.equal(calls, 1);
    if (state === 'rate_limit') { await clock.advance(1); assert.equal(calls, 1); await clock.advance(2_700_000); }
    else await clock.advance(1);
    assert.equal(calls, 2); schedule.stop();
  }
  for (const state of ['authentication', 'forbidden', 'identity', 'storage', 'response', 'configuration', 'paused']) {
    const clock = fakeClock(), schedule = new SyncSchedule(() => {}, clock);
    schedule.start(15, async () => result(state)); await clock.advance(0);
    assert.equal(schedule.enabled, false, state); assert.equal(clock.timers.size, 0);
  }
});

test('cancelled old round cannot rearm or stop a newly enabled schedule', async () => {
  const clock = fakeClock(), schedule = new SyncSchedule(() => {}, clock); let finish;
  schedule.start(15, () => new Promise(resolve => { finish = resolve; })); await clock.advance(0);
  schedule.stop(); schedule.start(30, async () => result());
  finish(result('authentication')); await flush();
  assert.equal(schedule.enabled, true); assert.equal(clock.timers.size, 1);
  await clock.advance(0); assert.equal(schedule.nextAt, 1_800_000);
  schedule.stop(); assert.throws(() => schedule.start(0, async () => result()), /15/);
});

test('scheduled rounds use real cursor recovery, later body fill and edit protection', async () => {
  const clock = fakeClock(), schedule = new SyncSchedule(() => {}, clock), files = new Map();
  const repository = new Repository(emptyState(), async () => {});
  const engine = new SyncEngine(repository, { async upsert(path, identity, content, previous) {
    const current = files.get(path);
    if (previous && digest(current) !== previous.hash) return { kind: 'conflict', path, hash: digest(current) };
    files.set(path, content); return { kind: current ? 'updated' : 'created', path, hash: digest(content) };
  } }, () => {}, clock.now);
  let round = 0; const cursors = [];
  const article = body => ({ id: 1, account: { fakeid: 'pub', nickname: '公众号' }, title: '标题',
    url: 'https://mp.weixin.qq.com/s/example', published_at: 100, updated_at: 100,
    body_state: body ? 'ready' : 'pending', body, publication_mode: '', native_publish_type: null,
    publication_type_source: '', publication_observed_at: null });
  const api = { account: 'account-a', async page(filter, cursor) {
    cursors.push(cursor); round++;
    if (round === 1) throw new SyncError('network', 'offline');
    return { items: round === 2 ? [article(null)] : round === 4 ? [article('Changed source')] : [], next_cursor: 'cursor', has_more: false };
  }, async article() { return article('Complete body'); } };
  schedule.start(15, () => engine.run(api, { directory: 'News', fakeids: ['pub'] }));
  await clock.advance(0); assert.equal(files.size, 0);
  await clock.advance(900_000); assert.match([...files.values()][0], /正文待补齐/);
  await clock.advance(900_000); assert.match([...files.values()][0], /Complete body/);
  const path = [...files.keys()][0], edited = files.get(path) + '\nMy edits'; files.set(path, edited);
  await clock.advance(900_000); assert.equal(files.get(path), edited);
  assert.deepEqual(cursors, [null, null, 'cursor', 'cursor']); schedule.stop();
});

async function pluginFixture() {
  const plugin = new Plugin(); await plugin.onload();
  plugin.api = { account: 'account-a' };
  plugin.settings.selections['account-a'] = ['publisher'];
  const clock = fakeClock(); plugin.schedule = new SyncSchedule(() => {}, clock);
  let calls = 0, pauses = 0;
  plugin.engine = { busy: false, pause() { pauses++; }, async run(api, filter) {
    calls++; assert.equal(api.account, 'account-a'); assert.deepEqual(filter.fakeids, ['publisher']); return result();
  } };
  return { plugin, clock, calls: () => calls, pauses: () => pauses };
}

test('real plugin wiring saves settings, runs, pauses and does not opt in on reload', async () => {
  const f = await pluginFixture();
  assert.equal(f.plugin.schedule.enabled, false);
  await f.plugin.startAutoSync(); await f.clock.advance(0); assert.equal(f.calls(), 1);
  assert.equal(f.plugin.saved.settings.intervalMinutes, 60);
  assert.equal(JSON.stringify(f.plugin.saved).includes('secret'), false);
  f.plugin.pause(); await f.clock.advance(3_600_000); assert.equal(f.calls(), 1);
  assert.equal(f.pauses(), 1);
  const restored = new Plugin(); restored.saved = f.plugin.saved; await restored.onload();
  assert.equal(restored.schedule.enabled, false); assert.equal(restored.api, null); restored.onunload();
});

test('real plugin cancels disconnect/unload and in-flight enabling after pause', async () => {
  for (const action of ['disconnect', 'onunload']) {
    const f = await pluginFixture(); await f.plugin.startAutoSync(); f.plugin[action]();
    await f.clock.advance(0); assert.equal(f.calls(), 0); assert.equal(f.plugin.schedule.enabled, false);
  }
  const f = await pluginFixture(); let saved;
  f.plugin.saveSettings = () => new Promise(resolve => { saved = resolve; });
  const enabling = f.plugin.startAutoSync(); f.plugin.pause(); saved(); await enabling;
  await f.clock.advance(0); assert.equal(f.calls(), 0); assert.equal(f.plugin.schedule.enabled, false);
});

test('real plugin never schedules on invalid selection or failed persistence', async () => {
  const f = await pluginFixture(); f.plugin.settings.selections['account-a'] = [];
  await f.plugin.startAutoSync(); assert.equal(f.plugin.progress.state, 'configuration');
  f.plugin.settings.selections['account-a'] = ['publisher'];
  f.plugin.saveSettings = async () => { throw new Error('disk full'); };
  await f.plugin.startAutoSync(); assert.equal(f.plugin.progress.state, 'storage');
  await f.clock.advance(0); assert.equal(f.calls(), 0); assert.equal(f.plugin.schedule.enabled, false);
});

test('manual permission failure also cancels an existing automatic timer', async () => {
  const f = await pluginFixture(); await f.plugin.startAutoSync(); await f.clock.advance(0);
  f.plugin.engine.run = async () => result('forbidden');
  assert.equal((await f.plugin.sync()).state, 'forbidden');
  assert.equal(f.plugin.schedule.enabled, false); assert.equal(f.clock.timers.size, 0);
});
