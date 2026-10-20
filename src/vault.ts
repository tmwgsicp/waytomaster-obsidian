import { App, FileSystemAdapter, TFile, TFolder, normalizePath } from 'obsidian';
import { lstat, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { FileRecord, VaultPort } from './sync';
import { digest } from './api';

export class ObsidianVault implements VaultPort {
  private identities: Map<string, TFile[]> | null = null;
  constructor(private readonly app: App) {}
  exists(path: string): boolean {
    const key = normalizePath(path).normalize('NFC').toLowerCase();
    return this.app.vault.getAllLoadedFiles().some(file => file.path.normalize('NFC').toLowerCase() === key);
  }
  async moveFolder(from: string, to: string, namespace: string): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(from);
    const destination = this.app.vault.getAbstractFileByPath(to);
    const owned = (folder: string) => {
      let matches = 0;
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!file.path.startsWith(folder + '/')) continue;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (fm?.wechatrss_namespace && fm.wechatrss_namespace !== namespace) throw new Error('folder_contains_other_account');
        if (fm?.wechatrss_namespace === namespace) matches++;
      }
      return matches;
    };
    if (source) {
      if (!(source instanceof TFolder) || destination || this.exists(to)) throw new Error('folder_move_target_occupied');
      const matches = owned(from);
      if (!matches && this.app.vault.getMarkdownFiles().some(file => file.path.startsWith(from + '/')))
        throw new Error('folder_ownership_not_ready');
      // Obsidian updates references when its file manager renames a folder.
      await this.app.fileManager.renameFile(source, to);
    } else if (destination && (!(destination instanceof TFolder) || !owned(to))) {
      throw new Error('folder_move_recovery_ambiguous');
    }
    const parent = this.app.vault.getAbstractFileByPath(from.slice(0, from.lastIndexOf('/')));
    if (parent instanceof TFolder && parent.children.length === 0) {
      try {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
          const full = adapter.getFullPath(parent.path);
          const inside = relative(await realpath(adapter.getFullPath('')), await realpath(full));
          if (!inside || inside.startsWith('..') || isAbsolute(inside) || (await lstat(full)).isSymbolicLink())
            throw new Error('unsafe_empty_folder');
          // Obsidian 1.14's nonrecursive rmdir delegates to fs.rm and fails on directories. fs.rmdir only removes an empty directory.
          await rmdir(full);
        } else await adapter.rmdir(parent.path, false);
      } catch (error) {
        // Hidden files and concurrent user additions stay in the old folder; cleanup never removes them.
        if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      }
    }
    this.identities = null;
  }
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
