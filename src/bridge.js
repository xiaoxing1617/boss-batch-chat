// 传话筒：main.js 运行在页面主环境，用不了扩展接口；它通过 postMessage 发请求，
// 这里（扩展的隔离环境）转给后台，再把结果传回去。只转发白名单里的几种请求。
(() => {
  if (window.top !== window) return;
  const ALLOW = new Set(['info', 'checkUpdate', 'openUpdater', 'keepAlive']);
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'bbc-page') return;
    const { id, type, data } = e.data;
    if (!ALLOW.has(type)) return;
    const reply = (result) => window.postMessage({ source: 'bbc-ext', id, result }, location.origin);
    try {
      chrome.runtime.sendMessage({ type, data }, (res) => {
        if (chrome.runtime.lastError) reply({ error: '扩展已重新加载，请刷新页面' });
        else reply(res || { error: '没有返回结果' });
      });
    } catch {
      reply({ error: '扩展已重新加载，请刷新页面' }); // 扩展更新 / 停用后，旧页面里的接口会失效
    }
  });
})();
