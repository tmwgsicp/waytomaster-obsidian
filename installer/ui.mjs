import {discoverVaults, inspectVault, install, verifyBundle} from './install.mjs';
const bundle = JSON.parse(document.getElementById('bundle').textContent);
const $ = id => document.getElementById(id);
$('version').textContent = bundle.version;
const media = matchMedia('(prefers-color-scheme: dark)');
function storedTheme() {
  try { const value = localStorage.getItem('wechatrss-theme'); return value === 'light' || value === 'dark' ? value : 'system'; }
  catch { return 'system'; }
}
function applyTheme() {
  document.documentElement.classList.toggle('dark', $('theme').value === 'dark' || ($('theme').value === 'system' && media.matches));
}
$('theme').value = storedTheme(); applyTheme();
$('theme').onchange = () => {
  try { if ($('theme').value === 'system') localStorage.removeItem('wechatrss-theme'); else localStorage.setItem('wechatrss-theme', $('theme').value); } catch {}
  applyTheme();
};
media.addEventListener('change', applyTheme);
window.addEventListener('storage', event => { if (event.key === 'wechatrss-theme') { $('theme').value = storedTheme(); applyTheme(); } });
function step(name) {
  for (const value of ['select', 'install', 'connect']) {
    if (value === name) $('step-' + value).setAttribute('aria-current', 'step');
    else $('step-' + value).removeAttribute('aria-current');
  }
}
let vault = null, busy = false, selectedPath = '', ambiguousName = false;
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
const supported = 'showDirectoryPicker' in window && window.isSecureContext;
const canDrop = supported && 'DataTransferItem' in window && 'getAsFileSystemHandle' in DataTransferItem.prototype;
$('drop-hint').hidden = !canDrop;
if (!supported) { $('unsupported').hidden = false; $('choose').disabled = true; }
let search = null;
async function showVault(chosen, label) {
  const found = await inspectVault(chosen);
  await verifyBundle(bundle);
  vault = chosen; selectedPath = label;
  $('selected').textContent = label + (found.existing ? ' · 已安装 ' + found.existing.version : ' · 尚未安装 WaytoMaster');
  $('selected').hidden = false; $('close-reminder').hidden = false; $('status').textContent = '';
  $('install').textContent = found.existing ? '安装 / 更新至 ' + bundle.version : '安装 WaytoMaster';
  $('install').disabled = false; $('install').hidden = false; $('choose').textContent = '换一个位置'; $('choose').className = 'secondary'; step('install');
}
async function selectVault(getHandle, label = '', ambiguous = false) {
  if (busy) return;
  busy = true; $('choose').disabled = true;
  step('select'); ambiguousName = ambiguous;
  error(''); $('status').textContent = ''; $('status').className = ''; $('install').disabled = true; $('install').hidden = true; $('done').hidden = true; $('selected').hidden = true; $('close-reminder').hidden = true; vault = null;
  $('candidates').replaceChildren(); $('results').hidden = true; $('search-note').textContent = ''; $('search-note').hidden = true;
  $('choose').textContent = '选择文件夹并查找'; $('choose').className = '';
  try {
    const chosen = await getHandle();
    if (!chosen || chosen.kind !== 'directory') throw Error('请选择文件夹，不是笔记文件或 ZIP。');
    if (chosen.name === '.obsidian') throw Error('选到了隐藏的配置文件夹，请选择它的上一级文件夹。');
    search = new AbortController(); $('cancel-search').hidden = false;
    $('status').textContent = '正在查找笔记库…';
    const found = await discoverVaults(chosen, {signal: search.signal});
    if (found.limited || found.unreadable) {
      $('search-note').textContent = '部分文件夹未能检查。若没有看到你的笔记库，请选择更接近笔记的位置重试。';
      $('search-note').hidden = false;
    }
    if (!found.vaults.length) {
      $('status').textContent = '';
      error('这里没有找到笔记库。请换一个位置；首次使用 Obsidian 时，需要先创建笔记库。');
    } else if (found.vaults.length === 1) {
      await showVault(found.vaults[0].handle, label || found.vaults[0].path);
    } else {
      $('status').textContent = '找到 ' + found.vaults.length + ' 个笔记库，请选择要安装的一个。';
      $('results').hidden = false;
      for (const item of found.vaults) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'secondary vault-choice'; button.textContent = item.path;
        button.onclick = () => selectVault(() => item.handle, item.path, found.vaults.some(other => other !== item && other.handle.name === item.handle.name));
        $('candidates').append(button);
      }
    }
  } catch (cause) {
    if (cause.name === 'AbortError') $('status').textContent = '已取消，未修改任何文件。可以重新选择。';
    else { $('status').textContent = ''; error(cause.name === 'NotAllowedError' || cause.name === 'SecurityError' ? '未获得文件夹访问权限，请选择文稿或其他存放笔记的文件夹，并允许访问。' : cause.message || '无法访问所选文件夹，请重新选择。'); }
  } finally { search = null; $('cancel-search').hidden = true; busy = false; $('choose').disabled = !supported; }
}
$('cancel-search').onclick = () => search?.abort();
$('choose').onclick = () => selectVault(() => window.showDirectoryPicker({id: 'waytomaster-vault', mode: 'read', startIn: 'documents'}));
// Obtain the handle during the drop event; the browser clears drag data after it returns.
$('drop-zone').ondragover = event => { event.preventDefault(); if (canDrop && !busy) $('drop-zone').classList.add('drag-over'); };
$('drop-zone').ondragleave = () => $('drop-zone').classList.remove('drag-over');
$('drop-zone').ondrop = event => {
  event.preventDefault(); $('drop-zone').classList.remove('drag-over');
  if (!canDrop || busy) return;
  const items = [...event.dataTransfer.items].filter(item => item.kind === 'file');
  if (items.length !== 1) { selectVault(() => { throw Error('请一次只拖入一个笔记文件夹。'); }); return; }
  selectVault(() => items[0].getAsFileSystemHandle());
};
$('install').onclick = async () => {
  if (busy || !vault) return;
  busy = true; $('choose').disabled = true; $('install').disabled = true; error('');
  $('status').textContent = '正在校验并安装…';
  try {
    if (await vault.requestPermission({mode: 'readwrite'}) !== 'granted') throw Error('未获得写入权限，尚未安装。点击安装重试，并允许修改文件夹。');
    const result = await install(vault, bundle);
    $('status').textContent = result.action === 'unchanged' ? '已经安装此版本，可以回到 Obsidian 启用。' : '安装完成，已有笔记和配置保持不变。';
    $('selected').textContent = vault.name + ' · 已安装 ' + result.version;
    $('install').textContent = '已安装';
    $('status').className = 'success'; $('setup').hidden = true; $('done').hidden = false; step('connect'); $('done').focus();
    $('open').hidden = ambiguousName;
    $('open-hint').textContent = ambiguousName ? '存在同名笔记库，请在 Obsidian 中打开刚才选择的：' + selectedPath : '没有跳转？手动打开 Obsidian 即可。';
    $('open').href = 'obsidian://open?' + new URLSearchParams({vault: vault.name});
  } catch (cause) { $('status').textContent = ''; error(cause.message || '安装未完成，请重新选择笔记库后重试。'); $('install').disabled = false; }
  finally { busy = false; $('choose').disabled = false; }
};

if (window.parent !== window) {
  new ResizeObserver(() => window.parent.postMessage({ type: 'waytomaster-installer-size', height: Math.ceil(document.body.getBoundingClientRect().height) }, location.origin)).observe(document.body);
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'waytomaster-theme') return;
    if (!['light', 'dark', 'system'].includes(event.data.preference)) return;
    $('theme').value = event.data.preference; applyTheme();
  });
}
