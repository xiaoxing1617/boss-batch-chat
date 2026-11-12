// 扩展后台：检查 GitHub 上的新版本、打开更新页、更新完成后刷新 Boss 页面。
// 只访问 GitHub 的公开接口，不发送任何用户数据。
const REPO = 'xiaoxing1617/boss-batch-chat';
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 小时内不重复请求 GitHub（未登录的接口每小时只能请求 60 次）

// 比较版本号：'0.10.0' > '0.9.3'
const cmpVer = (a, b) => {
  const pa = String(a || '0').replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
};

async function checkUpdate(force) {
  const current = chrome.runtime.getManifest().version;
  const withState = (info) => ({ ...info, current, hasUpdate: !!info.latest && cmpVer(info.latest, current) > 0 });
  const { upd } = await chrome.storage.local.get('upd');
  if (!force && upd && Date.now() - upd.at < CACHE_MS) return withState(upd.info);

  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
  } catch {
    throw new Error('连不上 GitHub，请检查网络（国内网络有时需要多试几次）');
  }
  let info;
  if (res.status === 404) info = { latest: null }; // 还没有发布任何版本
  else if (res.status === 403 || res.status === 429) throw new Error('GitHub 接口请求太频繁，请过一会儿再试');
  else if (!res.ok) throw new Error('GitHub 返回错误 ' + res.status);
  else {
    const j = await res.json();
    info = {
      latest: String(j.tag_name || '').replace(/^v/i, ''),
      name: j.name || j.tag_name,
      notes: String(j.body || '').slice(0, 3000),
      url: j.html_url,
      zip: j.zipball_url,
      publishedAt: j.published_at,
    };
  }
  await chrome.storage.local.set({ upd: { at: Date.now(), info } });
  return withState(info);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'info':
        return { version: chrome.runtime.getManifest().version };
      case 'checkUpdate':
        return checkUpdate(!!msg.data?.force);
      case 'openUpdater':
        await chrome.tabs.create({ url: chrome.runtime.getURL('src/update.html') });
        return { ok: true };
      default:
        throw new Error('未知请求');
    }
  })().then(sendResponse, (e) => sendResponse({ error: e?.message || String(e) }));
  return true; // 异步回复
});

// 一键更新写完文件后会重新加载扩展；重新启动时把打开着的 Boss 页面刷新一下，换成新代码
(async () => {
  const { reloadAfterUpdate } = await chrome.storage.local.get('reloadAfterUpdate');
  if (!reloadAfterUpdate) return;
  await chrome.storage.local.remove(['reloadAfterUpdate', 'upd']);
  if (Date.now() - reloadAfterUpdate > 5 * 60 * 1000) return; // 太久以前的标记，不处理
  const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/web/geek/*' });
  for (const t of tabs) chrome.tabs.reload(t.id);
  chrome.tabs.create({ url: chrome.runtime.getURL('src/update.html?done=1') });
})();
