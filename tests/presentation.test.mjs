import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { articleFilename, publisherFolder, markdown, Repository, SyncEngine, emptyState, digest } from '../.test-build/sync.mjs';
import { fixture, ObsidianVault } from '../.test-build/vault.mjs';

const article = (id, extra = {}) => ({ id, account: { fakeid: 'pub', nickname: '示例公众号' }, title: '同名文章',
  url: `https://mp.weixin.qq.com/s/${id}`, published_at: 1792368000, updated_at: 1792368000,
  body_state: 'ready', body: '正文', publication_mode: 'unknown', native_publish_type: null,
  publication_type_source: 'unknown', publication_observed_at: null, ...extra });
const filter = { fakeids: ['pub'], directory: 'Imported' };
const api = items => ({ account: 'account-a', async page() { return { items, next_cursor: 'cursor', has_more: false }; },
  async article(id) { return items.find(item => item.id === id); } });
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechatrss-obsidian-presentation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(root), repository = new Repository(emptyState(), async () => {});
  return { ...f, repository, engine: new SyncEngine(repository, new ObsidianVault(f.app), () => {}) };
}

test('title filenames are readable, bounded and collision-safe across forbidden characters and duplicate titles', () => {
  assert.equal(articleFilename(article(1)), '同名文章 · 1.md');
  assert.notEqual(articleFilename(article(1)), articleFilename(article(2)));
  for (const title of ['../../folder\\name:<>?*|#[]^', 'CON', ' . ', '汉😀'.repeat(200)]) {
    const filename = articleFilename(article(9, { title }));
    assert.doesNotMatch(filename, /[\\/:*?"<>|#\[\]^\u0000-\u001f]/);
    assert.ok(Buffer.byteLength(filename, 'utf8') < 150);
    assert.ok(!filename.startsWith('.')); assert.ok(filename.endsWith(' · 9.md'));
  }
});

test('API Markdown body is preserved byte-for-byte: headings, remote images, tables, links, code and raw HTML', () => {
  const content = [
    '## API heading', '', '![封面](https://mmbiz.qpic.cn/mmbiz_png/image?wx_fmt=png)', '',
    '| 项目 | 说明 |', '| --- | --- |', '| A | **重点** |', '',
    '[原链接](https://example.invalid/path?q=1&x=2)', '',
    '<table><tr><td rowspan="2">复杂表格</td><td>A</td></tr></table>', '',
    '<details><summary>说明</summary><p>原始 HTML</p></details>', '',
    '```html', '<img src="https://example.invalid/code-only.png">', '```', '',
    '[参考][ref]', '[ref]: https://example.invalid/reference',
  ].join('\n');
  const result = markdown(article(1, { title: '<b>标题</b> [链接](x)', body: content }), 'account-a', 'namespace');
  assert.ok(result.endsWith('\n\n' + content + '\n'));
  assert.ok(!result.includes('# <b>')); // Only plugin-added title is escaped.
  const properties = result.split('\n---\n')[0].split('\n').slice(1);
  assert.equal(properties.length, 16);
  assert.ok(properties.some(line => line.startsWith('publisher:')));
  assert.ok(properties.some(line => line.startsWith('published:') && line.includes('Z')));
  assert.ok(properties.some(line => line.startsWith('source:')));
  const metadata=Object.fromEntries(properties.map(line=>{const i=line.indexOf(':');return [line.slice(0,i),JSON.parse(line.slice(i+1))];}));
  const original=article(1);
  for(const key of ['publication_mode','native_publish_type','publication_type_source','publication_observed_at'])assert.equal(metadata[key],original[key]);
  assert.equal(metadata.source_updated_at,original.updated_at);
  assert.equal(metadata.publisher_id,original.account.fakeid);
  assert.equal(metadata.body_state,'ready');assert.equal(metadata.wechatrss_account,'account-a');
});

test('an identical leading API heading is not added twice, without stripping or rewriting the body', () => {
  const body='# 同名文章\n\n正文\n\n## 下一节';
  const result=markdown(article(1,{body}),'account-a','namespace');
  assert.equal(result.split('\n').filter(line=>line==='# 同名文章').length,1);
  assert.ok(result.endsWith('\n\n'+body+'\n'));
  const different=markdown(article(1,{body:'# 正文小节\n\n正文'}),'account-a','namespace');
  assert.ok(different.includes('# 同名文章\n\n# 正文小节'));
});

test('actual adapter keeps title changes and user renames on one stable file; same-title articles stay distinct', async t => {
  const f = await setup(t);
  await f.engine.run(api([article(1), article(2)]), filter);
  const first = Object.entries(f.repository.state.files).find(([key]) => key.endsWith(':1'));
  assert.match(first[1].path, /同名文章 · 1\.md$/);
  await f.engine.run(api([article(1, { title: '改过标题', body: '更新正文' })]), filter);
  assert.equal(Object.keys(f.repository.state.files).length, 2);
  assert.equal(f.repository.state.files[first[0]].path, first[1].path);
  const renamed = first[1].path.replace('同名文章 · 1.md', '我的文件.md');
  await f.move(first[1].path, renamed);
  const restarted = new SyncEngine(f.repository, new ObsidianVault(f.app), () => {});
  await restarted.run(api([article(1, { title: '再改标题', body: '再次更新' })]), filter);
  assert.equal(f.repository.state.files[first[0]].path, renamed);
  assert.ok((await f.read(renamed)).includes('再次更新'));
  await f.edit(renamed, (await f.read(renamed)) + '\n我的批注');
  const edited = await f.read(renamed);
  assert.equal((await restarted.run(api([article(1, { body: '不能覆盖' })]), filter)).conflicts, 1);
  assert.equal(await f.read(renamed), edited);
  assert.equal(f.app.vault.getMarkdownFiles().length, 2);
});

test('legacy ID filename stays at its recorded path and a user-occupied title filename is never overwritten', async t => {
  const f = await setup(t), namespace = digest('account-a\nImported'), legacyPath = 'Imported/account-a/1.md';
  await f.app.vault.createFolder('Imported/account-a');
  const old = `---\nwechatrss_id: 1\nwechatrss_namespace: "${namespace}"\n---\nOld body`;
  await f.app.vault.create(legacyPath, old);
  f.repository.state.files[`${namespace}:1`] = { path: legacyPath, hash: digest(old) };
  await f.engine.run(api([article(1)]), filter);
  assert.equal(f.repository.state.files[`${namespace}:1`].path, legacyPath);
  assert.ok((await f.read(legacyPath)).includes('正文'));
  const occupiedFolder = 'Imported/' + publisherFolder(article(2).account);
  await f.app.vault.createFolder(occupiedFolder);
  const occupied = occupiedFolder + '/' + articleFilename(article(2));
  await f.app.vault.create(occupied, 'User-owned text');
  const result = await f.engine.run(api([article(2)]), filter);
  assert.equal(result.conflicts, 1); assert.equal(await f.read(occupied), 'User-owned text');
});
