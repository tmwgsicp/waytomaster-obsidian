export const files = ['main.js', 'manifest.json', 'styles.css'];
export async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function verifyBundle(bundle) {
  if (Object.keys(bundle.assets).sort().join() !== [...files].sort().join()) throw Error('安装包内容不完整，请重新打开安装页面。');
  const data = {};
  for (const name of files) {
    const item = bundle.assets[name];
    const bytes = Uint8Array.from(atob(item.base64), c => c.charCodeAt(0));
    if (bytes.length > 10 * 1024 * 1024 || await digest(bytes) !== item.sha256) throw Error('安装包校验失败，未修改笔记库。');
    data[name] = bytes;
  }
  const info = JSON.parse(new TextDecoder().decode(data['manifest.json']));
  if (info.id !== 'wechatrss' || info.name !== 'WaytoMaster' || info.isDesktopOnly !== true || info.version !== bundle.version) throw Error('安装包身份不符。');
  return {data, info};
}
async function optionalFile(folder, name) {
  try { return new Uint8Array(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer()); }
  catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
}
async function optionalDirectory(folder, name) {
  try { return await folder.getDirectoryHandle(name); }
  catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
}
export async function inspectVault(vault) {
  const config = await optionalDirectory(vault, '.obsidian');
  if (!config) throw Error('没有找到 Obsidian 笔记库。请选存放笔记的最外层文件夹；如果是新文件夹，先在 Obsidian 中创建或打开它，再返回重试。');
  const plugins = await optionalDirectory(config, 'plugins');
  const target = plugins ? await optionalDirectory(plugins, 'wechatrss') : null;
  const raw = target ? await optionalFile(target, 'manifest.json') : null;
  let existing = null;
  if (raw) {
    try { existing = JSON.parse(new TextDecoder().decode(raw)); }
    catch { throw Error('已有插件信息无法读取，未覆盖任何文件。'); }
    if (existing.id !== 'wechatrss') throw Error('目标目录属于其他插件，未覆盖任何文件。');
  }
  return {config, plugins, target, existing};
}
async function write(folder, name, bytes) {
  const handle = await folder.getFileHandle(name, {create: true});
  const stream = await handle.createWritable();
  try { await stream.write(bytes); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
}
async function same(a, b) { return a === null || b === null ? a === b : await digest(a) === await digest(b); }
export async function install(vault, bundle) {
  const {data, info} = await verifyBundle(bundle);
  const found = await inspectVault(vault);
  if (found.existing) {
    const version = s => /^\d+\.\d+\.\d+$/.test(s) ? s.split('.').map(Number) : null;
    const before = version(found.existing.version), after = version(info.version);
    if (!before || !after) throw Error('无法判断现有插件版本，未自动覆盖。');
    for (let i = 0; i < 3; i++) {
      if (before[i] > after[i]) throw Error('已安装更新版本，请使用最新版安装页面。');
      if (before[i] < after[i]) break;
    }
  }
  const plugins = found.plugins || await found.config.getDirectoryHandle('plugins', {create: true});
  const target = found.target || await plugins.getDirectoryHandle('wechatrss', {create: true});
  const originals = {};
  for (const name of files) originals[name] = await optionalFile(target, name);
  if ((await Promise.all(files.map(name => same(originals[name], data[name])))).every(Boolean)) return {action: 'unchanged', version: info.version};
  let backup = null, backupName = '';
  if (files.some(name => originals[name] !== null)) {
    backupName = 'waytomaster-backup-' + crypto.randomUUID();
    backup = await plugins.getDirectoryHandle(backupName, {create: true});
    for (const name of files) if (originals[name] !== null) await write(backup, name, originals[name]);
  }
  const touched = [];
  try {
    for (const name of files) {
      if (!await same(await optionalFile(target, name), originals[name])) throw Error('安装期间插件文件发生变化。请关闭 Obsidian 后重试。');
      touched.push(name);
      await write(target, name, data[name]);
      if (!await same(await optionalFile(target, name), data[name])) throw Error('写入校验未通过。');
    }
  } catch (error) {
    try {
      for (const name of touched.reverse()) {
        if (originals[name] === null) {
          if (await optionalFile(target, name) !== null) await target.removeEntry(name);
        } else await write(target, name, originals[name]);
      }
    } catch {
      throw Error(backupName ? '安装未完成，原插件文件保存在 .obsidian/plugins/' + backupName + '。请保留该目录并联系支持。' : '安装未完成。笔记和设置未修改，请关闭 Obsidian 后重新安装。');
    }
    throw Error('安装未完成，已恢复原插件文件。' + error.message);
  }
  // Retain a single recovery snapshot for this upgrade; never copy settings or notes.
  return {action: found.existing ? 'upgrade' : 'install', version: info.version, backup: backupName};
}
