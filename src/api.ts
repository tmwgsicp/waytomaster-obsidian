import { createHash } from 'node:crypto';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface Credentials { endpoint: string; key: string; secret: string }
export interface Filter { fakeids: string[]; publishedAfter?: number; publishedBefore?: number; directory: string }
export interface Article {
  id: number; account: { fakeid: string; nickname: string }; title: string; url: string;
  published_at: number; updated_at: number; body_state: 'ready' | 'pending' | 'unavailable';
  body: string | null; publication_mode: string; native_publish_type: number | null;
  publication_type_source: string; publication_observed_at: number | null;
}
export interface Page { items: Article[]; next_cursor: string; has_more: boolean }
export interface Subscription { fakeid: string; nickname: string; is_active: boolean; access_since: number }
export interface ReaderIdentity { scope: string; subject: string; displayName: string }
export interface Response { status: number; headers: Record<string, string>; json: unknown }
export type Request = (url: string, headers: Record<string, string>) => Promise<Response>;

export class SyncError extends Error {
  constructor(public code: string, message: string, public retryAt = 0) { super(message); }
}
export function endpointOf(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SyncError('configuration', '请输入有效的 HTTPS 服务地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new SyncError('configuration', '服务地址须为 HTTPS 站点根地址，不能包含凭据或查询参数');
  return url.origin;
}
export function directoryOf(value: string): string {
  const path = value.trim().replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.split('/').some(p => !p || p === '..' || p === '.' || p.startsWith('.') || /[:*?"<>|\u0000-\u001f]/.test(p)))
    throw new SyncError('configuration', '请选择 Vault 内的普通目录，不能使用绝对路径、隐藏目录或 ..');
  return path;
}
export function canonicalFilter(filter: Filter): Filter {
  const fakeids = [...new Set(filter.fakeids)].sort();
  if (!fakeids.length || fakeids.some(v => typeof v !== 'string' || !v) || fakeids.length > 100)
    throw new SyncError('configuration', '请选择 1 至 100 个已订阅公众号');
  for (const value of [filter.publishedAfter, filter.publishedBefore])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new SyncError('configuration', '日期范围无效');
  if (filter.publishedAfter !== undefined && filter.publishedBefore !== undefined && filter.publishedAfter >= filter.publishedBefore)
    throw new SyncError('configuration', '结束时间必须晚于开始时间');
  return { fakeids, directory: directoryOf(filter.directory),
    publishedAfter: filter.publishedAfter, publishedBefore: filter.publishedBefore };
}
export const accountScope = (credentials: Credentials): string => digest(endpointOf(credentials.endpoint) + '\n' + credentials.key);
export const filterScope = (account: string, filter: Filter): string => digest(account + '\n' + JSON.stringify(canonicalFilter(filter)));

export function utcDate(value: string): number | undefined {
  if (!value) return undefined;
  const millis = Date.parse(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(millis)
      || new Date(millis).toISOString().slice(0, 10) !== value)
    throw new SyncError('configuration', '日期无效，请填写真实的 YYYY-MM-DD 日期');
  return millis / 1000;
}

export function safeResponse(response: { status: number; headers: Record<string, string>; json: unknown }): Response {
  // Error responses may be HTML from an upstream proxy; status still decides recovery.
  if (response.status < 200 || response.status >= 300) return { status: response.status, headers: response.headers, json: null };
  try { return { status: response.status, headers: response.headers, json: response.json }; }
  catch { throw new SyncError('response', '成功响应不是有效 JSON，已保留原同步位置'); }
}

function articleOf(raw: unknown): Article {
  const a = raw as Partial<Article> | null;
  if (!a || !Number.isSafeInteger(a.id) || Number(a.id) <= 0 || !a.account || typeof a.account.fakeid !== 'string'
      || typeof a.title !== 'string' || typeof a.url !== 'string' || !Number.isSafeInteger(a.published_at)
      || !Number.isSafeInteger(a.updated_at) || !['ready', 'pending', 'unavailable'].includes(String(a.body_state))
      || !(a.body === null || typeof a.body === 'string'))
    throw new SyncError('response', '文章响应格式异常，已保留原同步位置');
  return a as Article;
}
export class ArticleApi {
  readonly credentialScope: string;
  private syncScope: string;
  get account(): string { return this.syncScope; }
  useAccountScope(scope: string): void { this.syncScope = scope; }
  private readonly endpoint: string;
  constructor(private readonly credentials: Credentials, private readonly request: Request, private readonly now = Date.now) {
    this.endpoint = endpointOf(credentials.endpoint);
    if (!credentials.key.trim() || !credentials.secret.trim()) throw new SyncError('configuration', '请同时填写 API Key 和 API Secret');
    this.credentialScope = accountScope(credentials);
    this.syncScope = this.credentialScope;
  }
  async identity(): Promise<ReaderIdentity | null> {
    let raw: unknown;
    try { raw = await this.get('/api/v2/me'); }
    catch (error) {
      if (error instanceof SyncError && error.code === 'not_found') return null;
      throw error;
    }
    const value = raw as { subject?: unknown; display_name?: unknown } | null;
    if (!value || typeof value.subject !== 'string' || !/^local:[1-9]\d*$/.test(value.subject)
        || typeof value.display_name !== 'string' || !value.display_name.trim() || value.display_name.length > 500)
      throw new SyncError('response', '账号身份响应无效，未连接或合并已有同步范围');
    return { scope: digest(this.endpoint + '\nsubject\n' + value.subject),
      subject: value.subject, displayName: value.display_name };
  }
  private async get(path: string): Promise<unknown> {
    let response: Response;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([this.request(this.endpoint + path,
        { 'X-API-Key': this.credentials.key, 'X-API-Secret': this.credentials.secret }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SyncError('network', '请求超时，原同步位置已保留')), 20000); })]);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError('network', '网络请求失败，原同步位置已保留');
    } finally { if (timer) clearTimeout(timer); }
    if (response.status === 401) throw new SyncError('authentication', '凭据无效或已撤销，请重新连接');
    if (response.status === 403) throw new SyncError('forbidden', '当前账号或 API 权限不允许读取，请检查套餐与权限');
    if (response.status === 429) {
      const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const seconds = value && /^\d+$/.test(value) ? Number(value) : value ? (Date.parse(value) - this.now()) / 1000 : 3600;
      const delay = Number.isFinite(seconds) ? Math.min(86400, Math.max(1, seconds)) : 3600;
      throw new SyncError('rate_limit', '已达到读取频率限制，需等待至提示时间后再继续', this.now() + delay * 1000);
    }
    if (response.status === 404) throw new SyncError('not_found', '所选内容目前不可读取，未新增阅读权益');
    if (response.status < 200 || response.status >= 300) throw new SyncError('server', '服务暂时无法完成读取，请稍后重试');
    return response.json;
  }
  async subscriptions(): Promise<Subscription[]> {
    const data = await this.get('/api/subscriptions') as { subscriptions?: unknown[] };
    if (!Array.isArray(data?.subscriptions)) throw new SyncError('response', '订阅列表格式异常');
    return data.subscriptions.map(raw => {
      const row = raw as Subscription;
      if (!row || typeof row.fakeid !== 'string') throw new SyncError('response', '订阅列表格式异常');
      // Drop RSS tokens and unrelated response fields immediately.
      return { fakeid: row.fakeid, nickname: String(row.nickname || row.fakeid), is_active: !!row.is_active, access_since: Number(row.access_since || 0) };
    });
  }
  async page(filter: Filter, cursor: string | null): Promise<Page> {
    const query = new URLSearchParams({ order: 'ingested', include: 'body', body_format: 'markdown', limit: '50' });
    for (const fakeid of filter.fakeids) query.append('fakeid', fakeid);
    if (cursor) query.set('cursor', cursor);
    if (filter.publishedAfter !== undefined) query.set('published_after', String(filter.publishedAfter));
    if (filter.publishedBefore !== undefined) query.set('published_before', String(filter.publishedBefore));
    const raw = await this.get('/api/v2/articles?' + query) as Partial<Page>;
    if (!raw || !Array.isArray(raw.items) || raw.items.length > 50 || typeof raw.next_cursor !== 'string'
        || !raw.next_cursor || typeof raw.has_more !== 'boolean') throw new SyncError('response', '文章分页格式异常，已保留原同步位置');
    return { items: raw.items.map(articleOf), next_cursor: raw.next_cursor, has_more: raw.has_more };
  }
  async article(id: number): Promise<Article> { return articleOf(await this.get(`/api/v2/articles/${id}?body_format=markdown`)); }
}
