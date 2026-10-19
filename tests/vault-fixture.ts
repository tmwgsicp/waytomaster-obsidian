import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TFile, TFolder } from './obsidian-stub';
export { ObsidianVault } from '../src/vault';
export { digest } from '../src/api';

// A filesystem-backed test double of the Obsidian Vault API, never a real user Vault.
export function fixture(root: string) {
  const entries = new Map<string, TFile | TFolder>();
  const state = { active: null as TFile | null, scans: 0, beforeProcess: null as (() => Promise<void>) | null };
  const vault = {
    getAbstractFileByPath: (path: string) => entries.get(path) || null,
    getMarkdownFiles: () => { state.scans++; return [...entries.values()].filter((file): file is TFile => file instanceof TFile && file.path.endsWith('.md')); },
    async createFolder(path: string) { await mkdir(join(root, path), { recursive: true }); const folder = new TFolder(path); entries.set(path, folder); return folder; },
    async create(path: string, content: string) { await writeFile(join(root, path), content, { flag: 'wx' }); const file = new TFile(path); entries.set(path, file); return file; },
    async process(file: TFile, change: (text: string) => string) {
      if (state.beforeProcess) { const hook = state.beforeProcess; state.beforeProcess = null; await hook(); }
      const result = change(await readFile(join(root, file.path), 'utf8'));
      await writeFile(join(root, file.path), result);
      return result;
    },
  };
  return {
    app: { vault, workspace: { getActiveFile: () => state.active }, metadataCache: {
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
