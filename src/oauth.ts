import * as oauth from 'oauth4webapi';
import { SyncError } from './api';

export const ISSUER = 'https://account.waytomaster.com';
export const RESOURCE = 'https://wechatrss.waytomaster.com/api';
export const CALLBACK = 'obsidian://waytomaster-oauth';
export const SCOPE = 'content:read';
export const SECRET_ID = 'waytomaster-obsidian-wechatrss';
const server: oauth.AuthorizationServer = { issuer: ISSUER, authorization_endpoint: ISSUER + '/authorize',
  token_endpoint: ISSUER + '/token', revocation_endpoint: ISSUER + '/revoke' };
export interface Secrets { getSecret(id: string): string | null; setSecret(id: string, value: string): void }
export type OAuthFetch = NonNullable<oauth.HttpRequestOptions<string, URLSearchParams | string | undefined>[typeof oauth.customFetch]>;
interface Grant { clientId: string; refreshToken: string }
interface Pending { clientId: string; verifier: string; state: string; expires: number }

export class OAuthSession {
  private pending?: Pending;
  private grant?: Grant;
  private access?: { value: string; expires: number };
  private refreshing?: Promise<string>;
  private rotating?: Grant;
  private generation = 0;
  private readonly options;
  constructor(private readonly secrets: Secrets, private readonly fetcher: OAuthFetch, private readonly now = Date.now) {
    this.options = { [oauth.customFetch]: fetcher };
  }
  get clientId() { return this.grant?.clientId || ''; }
  get awaitingCallback() { return !!this.pending; }
  restore(): boolean {
    const saved = this.secrets.getSecret(SECRET_ID);
    if (!saved) return false;
    let value: Grant;
    try { value = JSON.parse(saved); } catch { throw new SyncError('storage', '保存的授权无法读取，请重新连接'); }
    if (!value || typeof value.clientId !== 'string' || !value.clientId || typeof value.refreshToken !== 'string' || !value.refreshToken)
      throw new SyncError('storage', '保存的授权不完整，请重新连接');
    this.grant = value;
    return true;
  }
  async begin(): Promise<string> {
    const generation = ++this.generation;
    this.pending = undefined;
    const response = await this.fetcher(ISSUER + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Obsidian 笔记同步 · WeChatRSS', redirect_uris: [CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE, token_endpoint_auth_method: 'none' }), redirect: 'manual' });
    if (generation !== this.generation) throw new SyncError('cancelled', '已取消连接');
    if (response.status !== 201) throw new SyncError('server', '账号服务暂时无法发起授权，请稍后重试');
    const registered = await response.json();
    if (typeof registered.client_id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(registered.client_id)
        || !(registered.scope || '').split(' ').includes(SCOPE))
      throw new SyncError('configuration', '服务端尚未开放笔记同步授权，请稍后更新服务再连接');
    const verifier = oauth.generateRandomCodeVerifier(), state = oauth.generateRandomState();
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);
    if (generation !== this.generation) throw new SyncError('cancelled', '已取消连接');
    this.pending = { clientId: registered.client_id, verifier, state, expires: this.now() + 10 * 60_000 };
    const url = new URL('https://wechatrss.waytomaster.com/connect/obsidian');
    url.search = new URLSearchParams({ client_id: registered.client_id, state, code_challenge: challenge }).toString();
    return url.href;
  }
  cancel() { this.generation++; this.pending = undefined; }
  private save(grant: Grant) { this.secrets.setSecret(SECRET_ID, JSON.stringify(grant)); this.grant = grant; }
  private accept(result: oauth.TokenEndpointResponse, clientId: string) {
    if (!result.refresh_token || !result.scope?.split(' ').includes(SCOPE) || result.token_type.toLowerCase() !== 'bearer'
        || !Number.isFinite(result.expires_in) || Number(result.expires_in) <= 0)
      throw new SyncError('authentication', '授权响应不完整，请重新连接');
    this.save({ clientId, refreshToken: result.refresh_token });
    this.access = { value: result.access_token, expires: this.now() + Number(result.expires_in) * 1000 };
    return result.access_token;
  }
  async complete(parameters: Record<string, string>): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.expires < this.now()) throw new SyncError('authentication', '连接请求已过期，请重新点击连接');
    const client = { client_id: pending.clientId };
    const params = oauth.validateAuthResponse(server, client, new URLSearchParams(parameters), pending.state);
    this.pending = undefined;
    const generation = this.generation;
    const response = await oauth.authorizationCodeGrantRequest(server, client, oauth.None(), params, CALLBACK, pending.verifier,
      { ...this.options, additionalParameters: { resource: RESOURCE } });
    const result = await oauth.processAuthorizationCodeResponse(server, client, response);
    if (generation !== this.generation) {
      if (result.refresh_token) await this.revoke({ clientId: pending.clientId, refreshToken: result.refresh_token });
      throw new SyncError('cancelled', '已取消连接');
    }
    this.accept(result, pending.clientId);
  }
  async token(): Promise<string> {
    if (this.access && this.access.expires > this.now() + 60_000) return this.access.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    const grant = this.grant;
    if (!grant) throw new SyncError('authentication', '请先连接 WaytoMaster');
    const generation = this.generation;
    // A timed-out rotation is ambiguous: never retry a potentially consumed token.
    this.rotating = grant;
    this.secrets.setSecret(SECRET_ID, ''); this.grant = undefined; this.access = undefined;
    try {
      const client = { client_id: grant.clientId };
      const response = await oauth.refreshTokenGrantRequest(server, client, oauth.None(), grant.refreshToken, this.options);
      const result = await oauth.processRefreshTokenResponse(server, client, response);
      if (generation !== this.generation) throw new SyncError('cancelled', '已断开连接');
      return this.accept(result, grant.clientId);
    } catch {
      throw new SyncError('authentication', '授权续期未完成，请重新连接；已有笔记和进度保留');
    } finally { this.rotating = undefined; }
  }
  async disconnect(): Promise<boolean> {
    const grant = this.grant || this.rotating;
    this.cancel(); this.grant = undefined; this.access = undefined;
    this.secrets.setSecret(SECRET_ID, '');
    return grant ? this.revoke(grant) : true;
  }
  private async revoke(grant: Grant): Promise<boolean> {
    try {
      const response = await oauth.revocationRequest(server, { client_id: grant.clientId }, oauth.None(), grant.refreshToken,
        { ...this.options, additionalParameters: { token_type_hint: 'refresh_token' } });
      return response.status === 200;
    } catch { return false; }
  }
}
