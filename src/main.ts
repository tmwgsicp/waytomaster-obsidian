import { App, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { ArticleApi, Filter, Subscription, SyncError, canonicalFilter, directoryOf, safeResponse, utcDate } from './api';
import { Progress, Repository, SyncEngine, SyncState, bindReaderIdentity, emptyState, knownAccountScope, progressText } from './sync';
import { ObsidianVault } from './vault';
import { SyncSchedule } from './schedule';
import { OAuthSession, ISSUER } from './oauth';
import { shell } from 'electron';

interface Settings {
  endpoint: string; directory: string; after: string; before: string;
  selections: Record<string, string[]>;
  intervalMinutes: number;
}
const defaults = (): Settings => ({ endpoint: 'https://wechatrss.waytomaster.com', directory: 'WeChatRSS',
  after: '', before: '', selections: {}, intervalMinutes: 60 });

export default class WeChatRSSPlugin extends Plugin {
  settings = defaults();
  repository!: Repository;
  engine!: SyncEngine;
  api: ArticleApi | null = null;
  oauth?: OAuthSession;
  authorizing = false;
  subscriptions: Subscription[] = [];
  credentials = { key: '', secret: '' };
  connectionMessage = '';
  connectionLabel = '';
  progress: Progress = { state: 'disconnected', message: '请选择内容来源并连接账号', processed: 0, pending: 0, conflicts: 0 };
  private status!: HTMLElement;
  private tab!: WeChatRSSSettings;
  private connecting = false;
  private generation = 0;
  private startingAuto = false;
  readonly schedule = new SyncSchedule(() => this.tab?.renderProgress());

  async onload() {
    const saved = await this.loadData();
    if (saved && saved.version !== 1) { new Notice('WeChatRSS 状态版本不支持，未修改已有内容'); return; }
    if (saved?.settings) {
      const old = saved.settings;
      this.settings = { endpoint: defaults().endpoint, directory: String(old.directory || 'WeChatRSS'),
        after: String(old.after || ''), before: String(old.before || ''), selections: old.selections || {},
        intervalMinutes: 60 };
    }
    const sync: SyncState = saved?.sync || emptyState();
    if (sync.version !== 1 || !sync.feeds || !sync.files || !sync.cooldowns) {
      new Notice('WeChatRSS 同步状态损坏，未重置断点或修改已有内容'); return;
    }
    this.repository = new Repository(sync, state => this.saveData({ version: 1, settings: this.settings, sync: state }));
    this.engine = new SyncEngine(this.repository, new ObsidianVault(this.app), progress => {
      this.progress = progress;
      this.status.setText(`WaytoMaster：${progressText(progress)}`);
      this.tab?.renderProgress();
    });
    this.status = this.addStatusBarItem();
    this.status.setText('WaytoMaster：尚未连接');
    this.tab = new WeChatRSSSettings(this.app, this);
    this.addSettingTab(this.tab);
    this.addCommand({ id: 'sync-selected', name: '手动同步所选公众号', callback: () => { void this.sync(); } });
    this.addCommand({ id: 'pause-sync', name: '暂停同步', callback: () => this.pause() });
    if (this.app.secretStorage) {
      this.oauth = new OAuthSession(this.app.secretStorage, async (url, options) => {
        if (new URL(url).origin !== ISSUER) throw new SyncError('configuration', '授权服务地址无效');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([requestUrl({ url, method: options.method,
            headers: Object.fromEntries(new Headers(options.headers)), body: options.body?.toString(), throw: false }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SyncError('network', '授权请求超时，请重新连接')), 20000); })]);
          return new Response(response.text, { status: response.status, headers: response.headers });
        } finally { if (timer !== undefined) clearTimeout(timer); }

      });
      this.registerObsidianProtocolHandler('waytomaster-oauth', params => { void this.finishAuthorization(params); });
      try { if (this.oauth.restore()) await this.connect(); }
      catch { this.progress.message = '授权无法恢复，请重新连接；已有笔记和进度保留'; }
    }

  }
  onunload() { this.oauth?.cancel(); this.generation++; this.schedule.stop(); this.engine?.pause(); this.api = null; this.credentials = { key: '', secret: '' }; }
  get busy() { return this.engine?.busy || this.connecting || this.startingAuto; }
  async saveSettings() { await this.repository.update(() => {}); }
  disconnect() {
    this.generation++;
    this.schedule.stop(); this.engine?.pause();
    this.api = null; this.subscriptions = []; this.connectionMessage = ''; this.connectionLabel = '';
    this.progress = { state: 'disconnected', message: '请连接 WeChatRSS 账号，读取你的公众号订阅', processed: 0, pending: 0, conflicts: 0 };
  }
  async authorize() {
    if (this.busy || this.authorizing || !this.oauth) return;
    this.authorizing = true;
    this.progress.message = '正在打开浏览器，请使用原平台账号登录并确认授权'; this.tab.display();
    try { await shell.openExternal(await this.oauth.begin()); }
    catch (error) {
      this.authorizing = false;
      this.progress.message = error instanceof SyncError ? error.message : '无法打开授权，请重试';
      this.tab.display();
    }
  }
  cancelAuthorization() {
    this.oauth?.cancel(); this.authorizing = false;
    this.progress.message = '已取消连接'; this.tab.display();
  }
  private async finishAuthorization(params: Record<string, string>) {
    if (!this.oauth?.awaitingCallback) return;
    try { await this.oauth.complete(params); this.authorizing = false; await this.connect(); }
    catch {
      this.authorizing = false;
      this.progress.message = '授权未完成或已取消，请重新连接'; this.tab.display();
    }
  }
  async revokeConnection() {
    this.pause(); this.disconnect(); this.credentials = { key: '', secret: '' };
    const revoked = await this.oauth?.disconnect();
    this.progress.message = revoked ? '已断开 WeChatRSS，笔记和进度保留' : '已停止同步；可在 WaytoMaster 账号中心确认撤销授权';
    this.tab.display();
  }
  async connect() {
    if (this.busy) return;
    this.schedule.stop();
    const generation = ++this.generation;
    this.connecting = true; this.api = null; this.subscriptions = []; this.connectionMessage = ''; this.connectionLabel = '';
    this.progress.message = '正在验证凭据并读取订阅…'; this.tab.display();
    let account = '';
    try {
      const auth = this.credentials.key ? { endpoint: this.settings.endpoint, ...this.credentials }
        : { endpoint: this.settings.endpoint, clientId: this.oauth?.clientId || '', accessToken: () => this.oauth!.token() };
      if (!this.credentials.key && !this.oauth?.clientId) throw new SyncError('authentication', '请先连接 WaytoMaster');
      const api = new ArticleApi(auth, async (url, headers) => {
        const response = await requestUrl({ url, method: 'GET', headers, throw: false });
        return safeResponse(response);
      });
      account = knownAccountScope(this.repository.state, api.credentialScope);
      const retryAt = this.repository.state.cooldowns[account] || 0;
      if (retryAt > Date.now()) throw new SyncError('rate_limit', '仍在读取限频等待期，请稍后手动继续', retryAt);
      const identity = await api.identity();
      if (generation !== this.generation) return;
      account = await bindReaderIdentity(this.repository, api.credentialScope, identity);
      if (generation !== this.generation) return;
      api.useAccountScope(account);
      const accountRetryAt = this.repository.state.cooldowns[account] || 0;
      if (accountRetryAt > Date.now()) throw new SyncError('rate_limit', '当前账号仍在读取限频等待期，请稍后继续', accountRetryAt);
      const subscriptions = await api.subscriptions();
      if (generation !== this.generation) return;
      const available = new Set(subscriptions.map(row => row.fakeid));
      this.settings.selections[api.account] = (this.settings.selections[api.account] || []).filter(id => available.has(id));
      await this.saveSettings();
      if (generation !== this.generation) return;
      this.api = api; this.subscriptions = subscriptions;
      this.connectionLabel = identity ? `已连接：${identity.displayName}` : '已连接 WeChatRSS';
      this.connectionMessage = identity
        ? `当前账号：${identity.displayName}（${identity.subject}）· 稳定身份已验证。同账号换 Key 可继续此范围。` +
          (account !== api.credentialScope ? ' 当前 Key 如有另一份旧范围，其笔记与断点仍保留，未自动合并。' : ' 已沿用当前 Key 原范围，笔记不搬迁。')
        : '兼容模式：服务未提供账号身份接口，仅按当前 Key 隔离。无法确认稳定账号，换 Key 不会继承断点；请升级服务后重连。';
      this.progress = { state: 'idle', message: `已读取 ${subscriptions.length} 个订阅，请选择后手动同步`, processed: 0, pending: 0, conflicts: 0 };
    } catch (error) {
      if (generation !== this.generation) return;
      const failure = error instanceof SyncError ? error : new SyncError('storage', '连接或保存设置失败，请重试');
      this.progress = { state: failure.code, message: failure.message, processed: 0, pending: 0, conflicts: 0, retryAt: failure.retryAt || undefined };
      if (account && failure.code === 'rate_limit') {
        try { await this.repository.update(state => { state.cooldowns[account] = failure.retryAt; }); }
        catch { this.progress.message = '无法保存限频状态，请检查 Vault 后再继续'; }
      }
    }
    finally { this.connecting = false; this.tab.display(); }
  }
  pause() {
    this.generation++;
    this.schedule.stop(); this.engine?.pause();
    this.progress.message = this.engine?.busy ? '正在暂停，当前请求结束后不会继续下一篇' : '已暂停自动同步，笔记和断点保留';
    this.tab?.display();
  }
  private selectedFilter(): Filter {
    return canonicalFilter({ directory: directoryOf(this.settings.directory), fakeids: this.settings.selections[this.api!.account] || [],
      publishedAfter: utcDate(this.settings.after), publishedBefore: utcDate(this.settings.before) });
  }
  async startAutoSync() {
    if (this.busy || !this.api || this.schedule.enabled) return;
    const generation = this.generation, api = this.api;
    this.startingAuto = true;
    this.tab.display();
    try {
      const filter = this.selectedFilter();
      await this.saveSettings();
      if (generation !== this.generation || api !== this.api) return;
      this.schedule.start(this.settings.intervalMinutes, () => this.sync(filter));
    } catch (error) {
      this.progress = { ...this.progress, state: error instanceof SyncError ? error.code : 'storage',
        message: error instanceof SyncError ? error.message : '无法保存设置，自动同步未开启' };
    } finally { this.startingAuto = false; this.tab.display(); }
  }
  async sync(selected?: Filter): Promise<Progress> {
    if (this.busy) return { ...this.progress, state: 'busy' };
    if (!this.api) { new Notice('请先在 WaytoMaster 设置中连接账号'); return { ...this.progress, state: 'disconnected' }; }
    try {
      const filter = selected || this.selectedFilter();
      const running = this.engine.run(this.api, filter);
      this.tab.display();
      const result = await running;
      if (!['idle', 'page_limit', 'network', 'server', 'rate_limit'].includes(result.state)) this.schedule.stop();
      if (result.state === 'authentication') { this.disconnect(); this.progress = result; }
      return result;
    } catch (error) {
      this.schedule.stop();
      this.progress = { ...this.progress, state: error instanceof SyncError ? error.code : 'storage',
        message: error instanceof SyncError ? error.message : '同步未完成，请检查本地状态' };
      return this.progress;
    }
    finally { this.tab.display(); }
  }
}

class WeChatRSSSettings extends PluginSettingTab {
  private status?: HTMLElement;
  private automatic?: HTMLElement;
  private search = '';
  constructor(app: App, private readonly plugin: WeChatRSSPlugin) { super(app, plugin); }
  renderProgress() {
    if (!this.status) return;
    const p = this.plugin.progress;
    this.status.setText(progressText(p, true));
    this.automatic?.setText(this.plugin.schedule.enabled
      ? this.plugin.schedule.nextAt ? `自动同步已开启 · 下次检查 ${new Date(this.plugin.schedule.nextAt).toLocaleString()}` : '自动同步已开启 · 本轮正在检查'
      : `自动同步未开启 · 开启后每 ${this.plugin.settings.intervalMinutes} 分钟检查一次`);
  }
  display() {
    const el = this.containerEl, plugin = this.plugin;
    el.empty();
    el.createEl('h2', { text: 'WaytoMaster' });
    el.createEl('p', { text: '把生态产品中有权阅读的内容保存到笔记库，保留你的编辑。' });
    new Setting(el).setName('内容来源').setDesc('WeChatRSS · 公众号文章。SocialRSS、InvestorRSS 尚未开放接入。');
    const textSetting = (container: HTMLElement, name: string, description: string, value: string, change: (value: string) => void, secret = false, disabled = false) => {
      new Setting(container).setName(name).setDesc(description).addText(text => {
        text.setValue(value).setDisabled(disabled || plugin.busy || plugin.schedule.enabled).onChange(change);
        if (secret) text.inputEl.type = 'password';
      });
    };
    el.createEl('h3', { text: 'WeChatRSS' });
    if (!plugin.api) {
      el.createEl('p', { text: '在浏览器中使用原 WeChatRSS 账号登录，关联并授权 WaytoMaster 后返回这里。无需复制密钥。' });
      new Setting(el).addButton(button => button.setButtonText(plugin.authorizing ? '等待浏览器授权…' : '连接 WeChatRSS')
        .setCta().setDisabled(plugin.busy || plugin.authorizing || !plugin.oauth).onClick(() => plugin.authorize()));
      if (plugin.authorizing) new Setting(el).addButton(button => button.setButtonText('取消连接').onClick(() => plugin.cancelAuthorization()));
      if (plugin.oauth?.clientId && !plugin.authorizing) new Setting(el).addButton(button => button.setButtonText('清除授权')
        .setDisabled(plugin.busy).onClick(() => plugin.revokeConnection()));
      if (!plugin.oauth) el.createEl('p', { text: '请升级到 Obsidian 1.11.4 或更新版本以使用安全授权存储。' });
    } else {
      new Setting(el).setName(plugin.connectionLabel).addButton(button => button.setButtonText('断开连接')
        .setDisabled(plugin.busy || plugin.schedule.enabled).onClick(() => plugin.revokeConnection()));
    }
    if (plugin.api) {
      el.createEl('h3', { text: '选择公众号' });
      const account = plugin.api.account;
      new Setting(el).setName('搜索公众号').setDesc('按名称或公众号标识搜索；筛选不会取消已选项。一次可同步 1 至 100 个公众号。')
        .addText(text => text.setValue(this.search).setPlaceholder('输入名称或标识').setDisabled(plugin.busy)
          .onChange(value => { this.search = value; renderList(); }));
      const summary = el.createEl('p', { attr: { role: 'status' } });
      const list = el.createEl('div', { cls: 'wechatrss-subscriptions' });
      const renderList = () => {
        list.empty();
        const query = this.search.trim().toLocaleLowerCase();
        const matches = plugin.subscriptions.filter(row =>
          row.nickname.toLocaleLowerCase().includes(query) || row.fakeid.toLocaleLowerCase().includes(query));
        const updateSummary = () => summary.setText(`共 ${plugin.subscriptions.length} 个订阅 · 匹配 ${matches.length} 个 · 已选 ${(plugin.settings.selections[account] || []).length} 个` +
          (matches.length > 30 ? ' · 仅显示前 30 个，请继续输入以缩小范围' : matches.length ? '' : ' · 请尝试其他名称或标识'));
        updateSummary();
        for (const row of matches.slice(0, 30)) new Setting(list).setName(row.nickname + (row.is_active ? '' : '（已冻结）'))
          .addToggle(toggle => toggle.setValue((plugin.settings.selections[account] || []).includes(row.fakeid)).setDisabled(plugin.busy || plugin.schedule.enabled)
            .onChange(async value => {
              if (plugin.busy || plugin.schedule.enabled || plugin.api?.account !== account) return;
              const ids = new Set(plugin.settings.selections[account] || []);
              value ? ids.add(row.fakeid) : ids.delete(row.fakeid);
              plugin.settings.selections[account] = [...ids];
              updateSummary();
              try { await plugin.saveSettings(); } catch { new Notice('选择未能保存，请检查 Vault'); }
            }));
      };
      renderList();
      el.createEl('h3', { text: '同步文章' });
      textSetting(el, '保存到文件夹', '按“保存位置 / 公众号名称 / 文章”整理，重名时加序号。更改位置后，已有笔记仍保留在原处。', plugin.settings.directory,
        value => { plugin.settings.directory = value; });
      if (plugin.settings.after || plugin.settings.before) {
        new Setting(el).setName('之前设置了日期范围')
          .setDesc(`${plugin.settings.after || '不限开始'} 至 ${plugin.settings.before || '不限结束'}（UTC，结束日不包含）。`)
          .addButton(button => button.setButtonText('改为全部可读文章').setDisabled(plugin.busy || plugin.schedule.enabled)
            .onClick(async () => {
              const { after, before } = plugin.settings;
              plugin.settings.after = ''; plugin.settings.before = '';
              try { await plugin.saveSettings(); }
              catch { plugin.settings.after = after; plugin.settings.before = before; new Notice('设置未能保存，请检查笔记库'); }
              this.display();
            }));
      }
      el.createEl('p', { text: '只保存你在 WeChatRSS 中已有权限阅读的文章。自动同步每小时检查一次，需要保持 Obsidian 打开。' });
      new Setting(el).addButton(button => button.setButtonText('手动同步').setCta().setDisabled(plugin.busy).onClick(() => plugin.sync()))
        .addButton(button => button.setButtonText('开启自动同步').setDisabled(plugin.busy || plugin.schedule.enabled).onClick(() => plugin.startAutoSync()))
        .addButton(button => button.setButtonText('暂停').setDisabled(!plugin.busy && !plugin.schedule.enabled).onClick(() => plugin.pause()));
      this.automatic = el.createEl('p', { attr: { role: 'status' } });
    } else {
      this.automatic = undefined;
    }
    this.status = el.createEl('p', { cls: 'wechatrss-status', attr: { role: 'status' } });
    this.renderProgress();
    if (plugin.api && !plugin.connectionLabel.startsWith('已连接：')) {
      el.createEl('p', { text: '当前服务暂不支持识别同一账号的新密钥，更换密钥可能产生另一份同步记录。', cls: 'wechatrss-connection' });
    }
  }
}
