import { mkdir, readFile, writeFile, rename, rmdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TFile, TFolder } from './obsidian-stub';
export { ObsidianVault } from '../src/vault';
export { digest } from '../src/api';

// A filesystem-backed test double of the Obsidian Vault API, never a real user Vault.
export function fixture(root: string) {
  const entries = new Map<string, TFile | TFolder>();
  const state = { active: null as TFile | null, scans: 0, beforeProcess: null as (() => Promise<void>) | null };
  const refresh = () => {
    for (const folder of entries.values()) if (folder instanceof TFolder)
      folder.children = [...entries.values()].filter(file => file.path.slice(0, file.path.lastIndexOf('/')) === folder.path);
  };
  const vault = {
    adapter: { async rmdir(path: string, recursive: boolean) {
      if (recursive) throw Error('recursive deletion is forbidden');
      await rmdir(join(root, path)); entries.delete(path); refresh();
    } },
    getAllLoadedFiles: () => [...entries.values()],
    getAbstractFileByPath: (path: string) => entries.get(path) || null,
    getMarkdownFiles: () => { state.scans++; return [...entries.values()].filter((file): file is TFile => file instanceof TFile && file.path.endsWith('.md')); },
    async createFolder(path: string) { await mkdir(join(root, path), { recursive: true }); const folder = new TFolder(path); entries.set(path, folder); refresh(); return folder; },
    async create(path: string, content: string) { await writeFile(join(root, path), content, { flag: 'wx' }); const file = new TFile(path); entries.set(path, file); refresh(); return file; },
    async delete(folder: TFolder) { await rmdir(join(root, folder.path)); entries.delete(folder.path); refresh(); },
    async process(file: TFile, change: (text: string) => string) {
      if (state.beforeProcess) { const hook = state.beforeProcess; state.beforeProcess = null; await hook(); }
      const result = change(await readFile(join(root, file.path), 'utf8'));
      await writeFile(join(root, file.path), result);
      return result;
    },
  };
  return {
    app: { vault, fileManager: { async renameFile(file: TFile | TFolder, to: string) {
      const from = file.path;
      await rename(join(root, from), join(root, to));
      for (const entry of [...entries.values()]) if (entry.path === from || entry.path.startsWith(from + '/')) {
        entries.delete(entry.path); entry.path = to + entry.path.slice(from.length); entries.set(entry.path, entry);
      }
      refresh();
    } }, workspace: { getActiveFile: () => state.active }, metadataCache: {
      getFileCache(file: TFile) {
        const content = readFileSync(join(root, file.path), 'utf8');
        const frontmatter: Record<string, unknown> = {};
        for (const line of content.split('\n').slice(1)) {
          if (line === '---') break;
          const index = line.indexOf(':');
          if (index > 0) { try { frontmatter[line.slice(0, index)] = JSON.parse(line.slice(index + 1)); } catch {} }
        }
        return { frontmatter };
      },
    } }, state,
    read: (path: string) => readFile(join(root, path), 'utf8'),
    edit: (path: string, content: string) => writeFile(join(root, path), content),
    async move(from: string, to: string) { const file = entries.get(from)!; await rename(join(root, from), join(root, to)); entries.delete(from); file.path = to; entries.set(to, file); },
  };
}
