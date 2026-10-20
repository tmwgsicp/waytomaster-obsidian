import {inspectVault, install, verifyBundle} from './install.mjs';
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
let vault = null, busy = false;
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
const supported = 'showDirectoryPicker' in window && window.isSecureContext;
const canDrop = supported && 'DataTransferItem' in window && 'getAsFileSystemHandle' in DataTransferItem.prototype;
$('drop-hint').hidden = !canDrop;
if (!supported) { $('unsupported').hidden = false; $('choose').disabled = true; }
const isMac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
$('path-hint').textContent = isMac
  ? 'Mac：点击下方按钮后，可按 ⌘ + Shift + G，输入上面查到的文件夹路径，直接前往。'
  : 'Windows：点击下方按钮后，可在地址栏粘贴查到的文件夹路径，按回车前往。';
async function selectVault(getHandle) {
  if (busy) return;
  busy = true; $('choose').disabled = true;
  step('select');
  error(''); $('status').textContent = ''; $('status').className = ''; $('install').disabled = true; $('install').hidden = true; $('done').hidden = true; $('selected').hidden = true; $('close-reminder').hidden = true; vault = null;
  try {
    const chosen = await getHandle();
    if (!chosen || chosen.kind !== 'directory') throw Error('请选择整个笔记文件夹，不是笔记文件或 ZIP。');
    const found = await inspectVault(chosen);
    await verifyBundle(bundle);
    vault = chosen;
    $('selected').textContent = chosen.name + (found.existing ? ' · 已安装 ' + found.existing.version : ' · 尚未安装 WaytoMaster');
    $('selected').hidden = false; $('close-reminder').hidden = false; $('status').textContent = '';
    $('install').textContent = found.existing ? '安装 / 更新至 ' + bundle.version : '安装 WaytoMaster';
    $('install').disabled = false; $('install').hidden = false; $('choose').textContent = '换一个文件夹'; $('choose').className = 'secondary'; step('install');
  } catch (cause) {
    if (cause.name === 'AbortError') $('status').textContent = '已取消选择，未修改任何文件。可以重新选择。';
    else error(cause.name === 'NotAllowedError' ? '未获得文件夹访问权限。请重新选择，并在浏览器提示中允许访问文件夹。' : cause.message || '无法访问所选文件夹，请重新选择。');
  } finally { busy = false; $('choose').disabled = !supported; }
}
$('choose').onclick = () => selectVault(() => window.showDirectoryPicker({id: 'waytomaster-vault', mode: 'read'}));
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
