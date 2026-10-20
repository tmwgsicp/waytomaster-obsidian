export class TFile { constructor(public path: string) {} }
export class TFolder { children: (TFile | TFolder)[] = []; constructor(public path: string) {} }
export class FileSystemAdapter {}
export const normalizePath = (path: string) => path.replaceAll('\\', '/');

class Element {
  text = '';
  setText(text: string) { this.text = text; }
  empty() {}
  createEl() { return new Element(); }
}
export class Notice { constructor(public message: string) {} }
export class Plugin {
  app: unknown = {};
  saved: unknown = null;
  async loadData() { return this.saved; }
  async saveData(data: unknown) { this.saved = structuredClone(data); }
  addStatusBarItem() { return new Element(); }
  addSettingTab() {}
  addCommand() {}
}
export class PluginSettingTab {
  containerEl = new Element();
  constructor(..._args: unknown[]) {}
}
class Control {
  inputEl = { type: 'text' };
  setValue() { return this; }
  setDisabled() { return this; }
  setButtonText() { return this; }
  setPlaceholder() { return this; }
  setCta() { return this; }
  addOptions() { return this; }
  onChange() { return this; }
  onClick() { return this; }
}
export class Setting {
  constructor(..._args: unknown[]) {}
  setName() { return this; }
  setDesc() { return this; }
  addText(callback: (control: Control) => void) { callback(new Control()); return this; }
  addButton(callback: (control: Control) => void) { callback(new Control()); return this; }
  addToggle(callback: (control: Control) => void) { callback(new Control()); return this; }
  addDropdown(callback: (control: Control) => void) { callback(new Control()); return this; }
}
export async function requestUrl() { throw new Error('No network in the plugin fixture'); }
