import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { FileRecord, VaultPort } from './sync';
import { digest } from './api';

export class ObsidianVault implements VaultPort {
  private identities: Map<string, TFile[]> | null = null;
  constructor(private readonly app: App) {}
  private find(path: string, identity: string, previous?: FileRecord): TFile | null {
    const known = this.app.vault.getAbstractFileByPath(normalizePath(previous?.path || path));
    if (known instanceof TFile) return known;
    if (known) throw new Error('target_is_not_file');
    // One metadata-index pass per adapter, not one whole-vault pass per new article.
    if (!this.identities) {
      this.identities = new Map();
      for (const file of this.app.vault.getMarkdownFiles()) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (typeof fm?.wechatrss_namespace !== 'string' || !Number.isSafeInteger(fm.wechatrss_id)) continue;
        const key = `${fm.wechatrss_namespace}:${fm.wechatrss_id}`;
        this.identities.set(key, [...(this.identities.get(key) || []), file]);
      }
    }
    const matches = (this.identities.get(identity) || []).filter(file => this.app.vault.getAbstractFileByPath(file.path) === file);
    if (matches.length > 1) throw new Error('ambiguous_article_files');
    return matches[0] || null;
  }
  async upsert(path: string, identity: string, content: string, previous?: FileRecord) {
    const file = this.find(path, identity, previous);
    if (!file) {
      const parts = normalizePath(path).split('/');
      for (let i = 1; i < parts.length; i++) {
        const folderPath = parts.slice(0, i).join('/');
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (folder && !(folder instanceof TFolder)) throw new Error('folder_path_occupied');
        if (!folder) await this.app.vault.createFolder(folderPath);
      }
      const created = await this.app.vault.create(normalizePath(path), content);
      this.identities?.set(identity, [created]);
      return { kind: 'created' as const, path: created.path, hash: digest(content) };
    }
    let kind: 'updated' | 'unchanged' | 'conflict' = 'conflict';
    const saved = await this.app.vault.process(file, current => {
      if (current === content) { kind = 'unchanged'; return current; }
      if (!previous || digest(current) !== previous.hash || this.app.workspace.getActiveFile() === file) return current;
      kind = 'updated';
      return content;
    });
    return { kind, path: file.path, hash: digest(saved) };
  }
}
