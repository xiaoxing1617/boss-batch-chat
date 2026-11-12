// 一键更新：从 GitHub 下载最新发布版本的 zip，在浏览器里解压，写回扩展所在的文件夹，再重新加载扩展。
// 浏览器不允许扩展改自己的文件，所以第一次要用户选一次文件夹并允许修改（File System Access）。
const REPO_URL = 'https://github.com/xiaoxing1617/boss-batch-chat';
const EXT_NAME = 'Boss 批量沟通';
const $ = (id) => document.getElementById(id);
const current = chrome.runtime.getManifest().version;
let info = null;

$('cur').textContent = 'v' + current;
$('repo').href = REPO_URL;
$('dl').href = REPO_URL + '/releases/latest';
if (new URLSearchParams(location.search).get('done')) $('done').hidden = false;

const send = (type, data) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage({ type, data }, (res) => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : res))
  );

// ---------- 检查更新 ----------
async function check(force) {
  $('title').textContent = '正在检查更新…';
  $('meta').textContent = '';
  $('notes').hidden = true;
  $('upd').hidden = true;
  const r = await send('checkUpdate', { force });
  if (!r || r.error) {
    $('title').textContent = '检查更新失败';
    $('meta').textContent = (r && r.error) || '未知错误';
    return;
  }
  info = r;
  if (!r.latest) {
    $('title').textContent = '还没有发布任何版本';
    return;
  }
  const date = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString('zh-CN') : '';
  if (r.hasUpdate) {
    $('title').textContent = `发现新版本 v${r.latest}`;
    $('meta').textContent = `当前 v${current} → 最新 v${r.latest}${date ? ' · 发布于 ' + date : ''}`;
    $('upd').hidden = false;
    $('go').textContent = `一键更新到 v${r.latest}`;
    refreshForget();
  } else {
    $('title').textContent = '已经是最新版本 ✓';
    $('meta').textContent = `最新发布 v${r.latest}${date ? ' · ' + date : ''}`;
  }
  if (r.notes) {
    $('notes').textContent = r.notes;
    $('notes').hidden = false;
  }
}
$('recheck').addEventListener('click', () => check(true));

// ---------- 保存选过的文件夹（存在扩展自己的 IndexedDB 里） ----------
const db = () =>
  new Promise((res, rej) => {
    const r = indexedDB.open('bbc-updater', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const kv = async (mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const q = fn(t.objectStore('kv'));
    t.oncomplete = () => res(q && q.result);
    t.onerror = () => rej(t.error);
  });
};
const getDir = () => kv('readonly', (s) => s.get('dir')).catch(() => null);
const setDir = (h) => kv('readwrite', (s) => s.put(h, 'dir'));
const delDir = () => kv('readwrite', (s) => s.delete('dir'));
const refreshForget = async () => ($('forget').hidden = !(await getDir()));
$('forget').addEventListener('click', async () => {
  await delDir();
  refreshForget();
  step('ok', '已清除，下次更新时重新选择文件夹');
});

// ---------- 进度显示 ----------
const step = (kind, text) => {
  const el = document.createElement('div');
  el.className = 's-' + kind;
  el.textContent = { ok: '✓ ', err: '✗ ', run: '… ' }[kind] + text;
  $('steps').appendChild(el);
  return el;
};

// ---------- 解压 zip（GitHub 的 zip 用的是 store / deflate，浏览器自带的 DecompressionStream 就能解） ----------
async function unzip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('下载的压缩包不完整，请重试');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('压缩包格式不对');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8)
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('不支持的压缩方式：' + method);
    out.push({ name, data });
  }
  return out;
}

// 只写这些路径，防止压缩包里有意外的文件写到别处
const SAFE = /^(manifest\.json|LICENSE|README\.md|\.gitignore|(src|docs)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/;

async function writeFile(dir, path, data) {
  const parts = path.split('/');
  let d = dir;
  for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function readManifest(dir) {
  try {
    const f = await (await dir.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

// ---------- 一键更新 ----------
$('go').addEventListener('click', async () => {
  if (!info || !info.hasUpdate) return;
  $('go').disabled = true;
  $('steps').innerHTML = '';
  try {
    // 1. 拿到扩展文件夹（第一次要选）并确认有写权限
    let dir = await getDir();
    if (dir && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = null;
    if (!dir) {
      if (!window.showDirectoryPicker) throw new Error('这个浏览器不支持选择文件夹，请用下面的「手动更新方法」');
      try {
        dir = await window.showDirectoryPicker({ id: 'bbc-ext-dir', mode: 'readwrite' });
      } catch {
        throw new Error('没有选择文件夹，已取消');
      }
    }
    const mf = await readManifest(dir);
    if (!mf || mf.name !== EXT_NAME) throw new Error('选的文件夹不对：请选择里面直接有 manifest.json 的「boss-batch-chat」文件夹');
    if (mf.version !== current && !confirm(`这个文件夹里的版本是 v${mf.version}，和正在运行的 v${current} 不一样，可能不是 Chrome 正在加载的那个文件夹。\n\n仍然更新这个文件夹吗？`))
      throw new Error('已取消');
    await setDir(dir);
    step('ok', `扩展文件夹：${dir.name}`);

    // 2. 下载
    const s2 = step('run', `正在从 GitHub 下载 v${info.latest}…`);
    let buf;
    try {
      const res = await fetch(info.zip, { cache: 'no-store' });
      if (!res.ok) throw new Error('GitHub 返回 ' + res.status);
      buf = await res.arrayBuffer();
    } catch (e) {
      throw new Error('下载失败（' + e.message + '），请检查网络后重试，或用手动更新');
    }
    s2.className = 's-ok';
    s2.textContent = `✓ 已下载（${(buf.byteLength / 1024).toFixed(0)} KB）`;

    // 3. 解压并检查内容
    const files = (await unzip(buf))
      .map((f) => ({ path: f.name.split('/').slice(1).join('/'), data: f.data })) // 去掉 GitHub 加的顶层文件夹
      .filter((f) => f.path && SAFE.test(f.path) && !f.path.split('/').includes('..'));
    const newMf = files.find((f) => f.path === 'manifest.json');
    if (!newMf || !files.some((f) => f.path === 'src/main.js')) throw new Error('压缩包里缺少必要文件，已停止，原文件没有改动');
    const newVer = JSON.parse(new TextDecoder().decode(newMf.data)).version;
    step('ok', `已解压 ${files.length} 个文件（v${newVer}）`);

    // 4. 写入（manifest.json 最后写，中途失败时旧版本仍然能用）
    const s4 = step('run', '正在写入文件…');
    const ordered = [...files.filter((f) => f.path !== 'manifest.json'), newMf];
    for (const [i, f] of ordered.entries()) {
      s4.textContent = `… 正在写入 ${i + 1}/${ordered.length}：${f.path}`;
      await writeFile(dir, f.path, f.data);
    }
    s4.className = 's-ok';
    s4.textContent = `✓ 已写入 ${ordered.length} 个文件`;

    // 5. 重新加载扩展（后台启动后会刷新 Boss 页面并打开「更新完成」页）
    step('ok', '正在重新加载扩展…');
    await chrome.storage.local.set({ reloadAfterUpdate: Date.now() });
    setTimeout(() => chrome.runtime.reload(), 600);
  } catch (e) {
    step('err', e.message || String(e));
    $('go').disabled = false;
  }
});

check(false);
