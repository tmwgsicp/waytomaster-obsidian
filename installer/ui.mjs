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
if (!('showDirectoryPicker' in window) || !window.isSecureContext) {
  $('unsupported').hidden = false; $('choose').disabled = true;
}
$('choose').onclick = async () => {
  if (busy) return;
  step('select');
  error(''); $('status').textContent = ''; $('status').className = ''; $('install').disabled = true; $('install').hidden = true; $('done').hidden = true; vault = null;
  try {
    const chosen = await window.showDirectoryPicker({id: 'waytomaster-vault', mode: 'readwrite'});
    const found = await inspectVault(chosen);
    await verifyBundle(bundle);
    vault = chosen;
    $('selected').textContent = chosen.name + (found.existing ? ' · 已安装 ' + found.existing.version : ' · 尚未安装 WaytoMaster');
    $('selected').hidden = false; $('status').textContent = '';
    $('install').textContent = found.existing ? '安装 / 更新至 ' + bundle.version : '安装 WaytoMaster';
    $('install').disabled = false; $('install').hidden = false; $('choose').textContent = '重新选择'; $('choose').className = 'secondary'; step('install');
  } catch (cause) {
    $('selected').hidden = true;
    if (cause.name === 'AbortError') $('status').textContent = '已取消选择，未修改任何文件。可以重新选择。';
    else error(cause.name === 'NotAllowedError' ? '未获得文件夹访问权限。请重新选择，并在浏览器提示中允许修改文件。' : cause.message || '无法访问所选文件夹，请重新选择。');
  }
};
$('install').onclick = async () => {
  if (busy || !vault) return;
  busy = true; $('choose').disabled = true; $('install').disabled = true; error('');
  $('status').textContent = '正在校验并安装…';
  try {
    const result = await install(vault, bundle);
    $('status').textContent = result.action === 'unchanged' ? '已经安装此版本，可以回到 Obsidian 启用。' : '安装完成，已有笔记和配置保持不变。';
    $('selected').textContent = vault.name + ' · 已安装 ' + result.version;
    $('install').textContent = '已安装';
    $('status').className = 'success'; $('setup').hidden = true; $('done').hidden = false; step('connect'); $('done').focus();
    $('open').href = 'obsidian://open?' + new URLSearchParams({vault: vault.name});
  } catch (cause) { $('status').textContent = ''; error(cause.message || '安装未完成，请重新选择笔记库后重试。'); $('install').disabled = false; }
  finally { busy = false; $('choose').disabled = false; }
};
