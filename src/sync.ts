import { Article, Filter, ReaderIdentity, SyncError, canonicalFilter, digest, directoryOf, filterScope } from './api';
export { SyncError, digest, filterScope, canonicalFilter, accountScope } from './api';

export interface FileRecord { path: string; hash: string }
export type Pending = 'pending' | 'unavailable' | 'conflict' | 'blocked';
export interface Feed { cursor: string | null; pending: Record<string, Pending>; pendingCursor: number }
export interface SyncState {
  version: 1; feeds: Record<string, Feed>; files: Record<string, FileRecord>; cooldowns: Record<string, number>;
  publisherFolders?: Record<string, string>;
  identities?: { accounts: Record<string, string>; credentials: Record<string, string> };
}
export const emptyState = (): SyncState => ({ version: 1, feeds: {}, files: {}, cooldowns: {} });
export class Repository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public state: SyncState, private readonly persist: (state: SyncState) => Promise<void>) {}
  update(change: (state: SyncState) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      change(next);
      await this.persist(next);
      this.state = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

function identityBindings(state: SyncState): NonNullable<SyncState['identities']> {
  const bindings = state.identities === undefined ? { accounts: {}, credentials: {} } : state.identities;
  const validMap = (value: unknown): value is Record<string, string> => !!value && typeof value === 'object'
    && !Array.isArray(value) && Object.entries(value).every(([key, entry]) => /^[a-f0-9]{64}$/.test(key)
      && typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry));
  if (!bindings || !validMap(bindings.accounts) || !validMap(bindings.credentials)
      || new Set(Object.values(bindings.accounts)).size !== Object.keys(bindings.accounts).length
      || Object.values(bindings.credentials).some(owner => !bindings.accounts[owner])
      || Object.entries(bindings.accounts).some(([owner, scope]) => bindings.credentials[scope] !== owner))
    throw new SyncError('storage', '账号绑定记录损坏，未重置笔记或同步位置');
  return bindings;
}

export function knownAccountScope(state: SyncState, credential: string): string {
  const bindings = identityBindings(state);
  const owner = bindings.credentials[credential];
  return owner ? bindings.accounts[owner] : credential;
}

export async function bindReaderIdentity(repository: Repository, credential: string, identity: ReaderIdentity | null): Promise<string> {
  const previous = identityBindings(repository.state);
  if (!identity) {
    if (previous.credentials[credential])
      throw new SyncError('identity', '服务暂不支持账号身份验证，无法恢复已绑定范围；请升级服务后重连，已有笔记和断点保留');
    return credential;
  }
  const owner = previous.credentials[credential];
  if (owner && owner !== identity.scope)
    throw new SyncError('identity', '当前 Key 返回了不同账号身份，已停止连接；不会合并或覆盖已有笔记');
  let account = credential;
  await repository.update(state => {
    const bindings = identityBindings(state);
    if (bindings.credentials[credential] && bindings.credentials[credential] !== identity.scope)
      throw new SyncError('identity', '账号绑定已变化，请重新连接');
    account = bindings.accounts[identity.scope] || credential;
    bindings.accounts[identity.scope] = account;
    bindings.credentials[credential] = identity.scope;
    state.identities = bindings;
    state.cooldowns[account] = Math.max(state.cooldowns[account] || 0, state.cooldowns[credential] || 0);
  });
  return account;
}
export interface VaultPort {
  upsert(path: string, identity: string, content: string, previous?: FileRecord): Promise<{
    kind: 'created' | 'updated' | 'unchanged' | 'conflict'; path: string; hash: string;
  }>;
}
export interface SyncApi { account: string; page(filter: Filter, cursor: string | null): Promise<{
  items: Article[]; next_cursor: string; has_more: boolean }>; article(id: number): Promise<Article> }
export interface Progress { state: string; message: string; processed: number; pending: number; conflicts: number; retryAt?: number }

function pathLabel(value: string, maxBytes: number): string {
  const clean = value.normalize('NFC').replace(/[\\/:*?"<>|#\[\]^\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  let title = '';
  for (const character of clean) {
    if (Buffer.byteLength(title + character, 'utf8') > maxBytes) break;
    title += character;
  }
  return title.replace(/[. ]+$/g, '');
}

export function articleFilename(article: Pick<Article, 'id' | 'title'>): string {
  return `${pathLabel(article.title, 120) || '未命名文章'} · ${article.id}.md`;
}

export function publisherFolder(account: Article['account']): string {
  const name = typeof account.nickname === 'string' ? account.nickname : '';
  return `${pathLabel(name, 72) || '未命名公众号'} · ${digest(account.fakeid).slice(0, 12)}`;
}

export function markdown(article: Article, account: string, namespace: string): string {
  const quote = (value: unknown) => JSON.stringify(value ?? null);
  const published = new Date(article.published_at * 1000);
  const frontmatter = {
    publisher: article.account.nickname,
    published: article.published_at > 0 && Number.isFinite(published.getTime()) ? published.toISOString() : null,
    source: article.url,
    wechatrss_id: article.id, wechatrss_account: account, wechatrss_namespace: namespace,
    title: article.title, publisher_id: article.account.fakeid,
    published_at: article.published_at, source_updated_at: article.updated_at,
    body_state: article.body_state === 'ready' && !article.body ? 'pending' : article.body_state,
    publication_mode: article.publication_mode, native_publish_type: article.native_publish_type,
    publication_type_source: article.publication_type_source, publication_observed_at: article.publication_observed_at,
    cssclasses: ['wechatrss-article'],
  };
  const body = article.body_state === 'ready' && article.body ? article.body :
    article.body_state === 'unavailable' ? '> 正文目前不可用。后续同步会重新检查。' : '> 正文待补齐。后续同步会重新检查。';
  const title = article.title.replace(/[\r\n]/g, ' ');
  const escapedTitle = title.replace(/[\\`*_[\]<>#]/g, '\\$&');
  const firstLine = body.trimStart().split(/\r?\n/, 1)[0];
  const heading = firstLine === `# ${title}` || firstLine === `# ${escapedTitle}` ? '' : `# ${escapedTitle}\n\n`;
  return '---\n' + Object.entries(frontmatter).map(([key, value]) => `${key}: ${quote(value)}`).join('\n') +
    '\n---\n\n' + heading + body + '\n';
}

export class SyncEngine {
  private paused = false;
  busy = false;
  constructor(readonly repository: Repository, readonly vault: VaultPort, private readonly progress: (value: Progress) => void,
    private readonly now = Date.now) {}
  pause(): void { this.paused = true; }

  async run(api: SyncApi, rawFilter: Filter): Promise<Progress> {
    if (this.busy) throw new SyncError('busy', '已有同步正在运行');
    const filter = canonicalFilter(rawFilter), scope = filterScope(api.account, filter);
    const namespace = digest(api.account + '\n' + filter.directory);
    let processed = 0;
    const report = (state: string, message: string, retryAt?: number) => {
      const pending = Object.values(this.repository.state.feeds[scope]?.pending || {});
      const value = { state, message, processed, pending: pending.filter(p => p !== 'conflict').length,
        conflicts: pending.filter(p => p === 'conflict').length, retryAt };
      this.progress(value);
      return value;
    };
    const stopped = () => { if (this.paused) throw new SyncError('paused', '已暂停，已写入内容和断点均保留'); };
    const accept = async (article: Article) => {
      stopped();
      if (!filter.fakeids.includes(article.account.fakeid)
          || (filter.publishedAfter !== undefined && article.published_at < filter.publishedAfter)
          || (filter.publishedBefore !== undefined && article.published_at >= filter.publishedBefore))
        throw new SyncError('response', '返回文章与所选范围不符，已停止写入');
      const identity = `${namespace}:${article.id}`;
      const fileKey = `${namespace}:${article.id}`;
      const publisherKey = `${namespace}:${article.account.fakeid}`;
      let folder = this.repository.state.publisherFolders?.[publisherKey];
      if (folder === undefined) {
        folder = publisherFolder(article.account);
        // Persist the first name before any note write so retry/restart cannot split a renamed publisher.
        await this.repository.update(state => { (state.publisherFolders ||= {})[publisherKey] = folder!; });
      }
      try {
        if (typeof folder !== 'string' || directoryOf(folder) !== folder || folder.includes('/')) throw new Error('invalid_folder');
      } catch {
        throw new SyncError('storage', '公众号目录记录无效，已保留已有笔记和断点');
      }
      stopped();
      const target = `${filter.directory}/${api.account.slice(0, 24)}/${folder}/${articleFilename(article)}`;
      const previous = this.repository.state.files[fileKey];
      const result = await this.vault.upsert(target, identity, markdown(article, api.account, namespace), previous);
      await this.repository.update(state => {
        const feed = state.feeds[scope];
        if (result.kind === 'conflict') feed.pending[String(article.id)] = 'conflict';
        else {
          state.files[fileKey] = { path: result.path, hash: result.hash };
          if (article.body_state === 'ready' && article.body) delete feed.pending[String(article.id)];
          else feed.pending[String(article.id)] = article.body_state === 'unavailable' ? 'unavailable' : 'pending';
        }
      });
      processed++;
      report('running', '正在同步所选文章');
    };

    this.busy = true;
    this.paused = false;
    try {
      const folders = this.repository.state.publisherFolders;
      if (folders !== undefined && (!folders || typeof folders !== 'object' || Array.isArray(folders)))
        throw new SyncError('storage', '公众号目录记录损坏，未重置已有数据');
      const until = this.repository.state.cooldowns[api.account] || 0;
      if (until > this.now()) return report('rate_limit', '仍在读取限频等待期，需等待至提示时间后再继续', until);
      await this.repository.update(state => { state.feeds[scope] ||= { cursor: null, pending: {}, pendingCursor: 0 }; });
      report('running', '正在检查待补正文与新增文章');
      const feed = this.repository.state.feeds[scope];
      const pendingIds = Object.keys(feed.pending).map(Number).sort((a, b) => a - b);
      const ordered = [...pendingIds.filter(id => id > feed.pendingCursor), ...pendingIds.filter(id => id <= feed.pendingCursor)].slice(0, 10);
      for (const id of ordered) {
        stopped();
        try {
          const article = await api.article(id);
          if (article.id !== id) throw new SyncError('response', '单篇返回标识不一致，已停止写入');
          await accept(article);
        } catch (error) {
          if (!(error instanceof SyncError) || error.code !== 'not_found') throw error;
          await this.repository.update(state => { state.feeds[scope].pending[String(id)] = 'blocked'; });
        }
        await this.repository.update(state => { state.feeds[scope].pendingCursor = id; });
      }
      for (let pages = 0; pages < 20; pages++) {
        stopped();
        const cursor = this.repository.state.feeds[scope].cursor;
        const page = await api.page(filter, cursor);
        stopped();
        if (page.has_more && page.next_cursor === cursor) throw new SyncError('response', '分页位置未前进，已保留原断点');
        for (const article of page.items) await accept(article);
        stopped();
        // Cursor advances only after every write or pending/conflict receipt is durable.
        await this.repository.update(state => { state.feeds[scope].cursor = page.next_cursor; });
        if (!page.has_more) return report('idle', '本轮检查结束；待补正文和编辑冲突会单独保留');
      }
      return report('page_limit', '本轮已读取 20 页；下一轮同步会从断点继续');
    } catch (error) {
      const failure = error instanceof SyncError ? error : new SyncError('storage', '本地写入或保存失败，原分页断点已保留，请检查 Vault');
      if (failure.code === 'rate_limit') {
        try { await this.repository.update(state => { state.cooldowns[api.account] = failure.retryAt; }); }
        catch { return report('storage', '无法保存限频恢复状态，请检查 Vault 后再继续'); }
      }
      return report(failure.code, failure.message, failure.retryAt || undefined);
    } finally { this.busy = false; }
  }
}
