// Boss 批量沟通 v0.5
// 职位列表页：左侧勾选职位 → 逐个处理（没沟通过先「立即沟通」）→ 右侧切到「沟通」tab →
// 按顺序发送多条文本/图片消息，每条确认发送成功再发下一条 → 再处理下一个职位。
// 运行在页面主环境（world: MAIN），才能读到职位卡片上的 Vue 数据。
(() => {
  if (window.__bossBatchChat) return;
  window.__bossBatchChat = true;

  // 嵌在「沟通」tab 里的聊天页：只隐藏顶部导航，其余由外层页面驱动
  if (window.top !== window) {
    if (location.pathname.startsWith('/web/geek/chat')) {
      const st = document.createElement('style');
      st.textContent = '#header, .page-header, .inner.home-inner { display: none !important; } body { min-width: 0 !important; }';
      document.head.appendChild(st);
      // 嵌入后窗口比较窄：滚到最右边，让聊天窗口（实时发送情况）露出来
      const toRight = () => {
        const se = document.scrollingElement;
        if (se) se.scrollLeft = se.scrollWidth;
      };
      addEventListener('resize', toRight);
      addEventListener('load', () => [0, 600, 1500, 3000].forEach((t) => setTimeout(toRight, t)));
    }
    return;
  }

  const onJobs = location.pathname.startsWith('/web/geek/job');
  const onChat = location.pathname.startsWith('/web/geek/chat');
  if (!onJobs && !onChat) return;

  // ================= 通用工具 =================
  const STORE_KEY = 'bbc_v2';
  const MAX_PER_RUN = 100;
  const REPO_URL = 'https://github.com/xiaoxing1617/boss-batch-chat';
  const CLOCK_ICON =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>';
  const GH_ICON =
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  // 后台保活①：等待计时交给一个独立的小线程（Web Worker）。
  // 标签页切到后台后，Chrome 会把页面里的 setTimeout 拖慢到 1 秒甚至 1 分钟一次，但 Worker 里的计时不受影响，
  // 时间到了它发消息叫醒页面，这样切走标签页也能按正常节奏发送。Worker 建不起来就退回普通计时。
  let timerWorker = null;
  let timerSeq = 0;
  const timerWait = new Map();
  const getTimerWorker = () => {
    if (timerWorker !== null) return timerWorker;
    try {
      const src = 'onmessage=(e)=>setTimeout(()=>postMessage(e.data.id),e.data.ms)';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      timerWorker = new Worker(url);
      URL.revokeObjectURL(url);
      timerWorker.onmessage = (e) => {
        const r = timerWait.get(e.data);
        timerWait.delete(e.data);
        r?.();
      };
      timerWorker.onerror = () => {
        timerWorker = false; // 出错就退回普通计时，把正在等的都放行
        timerWait.forEach((r) => setTimeout(r, 0));
        timerWait.clear();
      };
    } catch {
      timerWorker = false;
    }
    return timerWorker;
  };
  const sleep = (ms) =>
    new Promise((r) => {
      const w = getTimerWorker();
      if (!w) return setTimeout(r, ms);
      const id = ++timerSeq;
      timerWait.set(id, r);
      w.postMessage({ id, ms });
    });
  const rand = (a, b) => a + Math.random() * (b - a);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const isVisible = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const view = el.ownerDocument.defaultView;
    return view.getComputedStyle(el).visibility !== 'hidden';
  };
  const waitFor = async (fn, timeout = 8000, step = 200) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };
  const findByText = (root, selector, re) =>
    [...root.querySelectorAll(selector)].find((el) => isVisible(el) && re.test(el.textContent.trim()));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fillTpl = (tpl, j) =>
    tpl
      .replace(/\{公司\}/g, j.brandName || '')
      .replace(/\{岗位\}/g, j.jobName || '')
      .replace(/\{HR\}/g, j.bossName || '')
      .replace(/\{薪资\}/g, j.salaryDesc || '');

  const DEFAULT_SEQ = [
    { id: uid(), type: 'text', text: '您好，我对{公司}的{岗位}职位很感兴趣，我的经验和这个岗位比较匹配，期待和您进一步沟通！' },
  ];
  const state = Object.assign(
    { seq: DEFAULT_SEQ, library: [], phrases: [], minSec: 5, maxSec: 12, sendSeq: true, selected: {}, sentLog: {}, pos: null, collapsed: false, diag: '' },
    (() => {
      try {
        return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
      } catch {
        return {};
      }
    })()
  );
  state.selected = {}; // 勾选只在当前页面有效：刷新/翻页后清空，避免带上看不见的旧勾选
  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {}
  };

  // 图片存 IndexedDB（zhipin.com 域下），不上传任何地方
  const imgDB = (() => {
    let dbp;
    const open = () =>
      dbp ||
      (dbp = new Promise((res, rej) => {
        const r = indexedDB.open('bbc', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('img');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('img', mode);
        const req = fn(t.objectStore('img'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      put: (k, v) => run('readwrite', (s) => s.put(v, k)),
      get: (k) => run('readonly', (s) => s.get(k)),
      del: (k) => run('readwrite', (s) => s.delete(k)),
    };
  })();

  // ================= 面板 =================
  const panel = document.createElement('div');
  panel.id = 'bbc-panel';
  panel.innerHTML = `
    <div class="bbc-head">
      <div class="bbc-title"><span class="bbc-logo">B</span><span>Boss 批量沟通</span><span class="bbc-count"></span></div>
      <span class="bbc-head-ops">
        <a class="bbc-hbtn bbc-gh" href="${REPO_URL}" target="_blank" rel="noopener" title="GitHub 开源地址（欢迎点个 Star ⭐）">${GH_ICON}</a>
        <span class="bbc-hbtn bbc-home" title="回到右下角默认位置">⇲</span>
        <span class="bbc-hbtn bbc-fold" title="收起 / 展开">—</span>
      </span>
    </div>

    <div class="bbc-steps bbc-jobs-only">
      <button class="bbc-step" data-step="1" data-goto="sel"><b>1</b><span>勾选职位</span><em class="bbc-step-sub">已选 0</em></button>
      <i class="bbc-step-arrow">›</i>
      <button class="bbc-step" data-step="2" data-goto="msg"><b>2</b><span>编排消息</span><em class="bbc-step-sub">0 条</em></button>
      <i class="bbc-step-arrow">›</i>
      <button class="bbc-step" data-step="3" data-goto="start"><b>3</b><span>开始沟通</span><em class="bbc-step-sub">点底部按钮</em></button>
    </div>

    <div class="bbc-nav">
      <button class="bbc-nav-btn" data-page="msg">批量消息</button>
      <button class="bbc-nav-btn bbc-jobs-only" data-page="sel">已选 <span class="bbc-badge bbc-sel-n">0</span></button>
      <button class="bbc-nav-btn" data-page="lib">文本库</button>
      <button class="bbc-nav-btn" data-page="rec">记录</button>
      <button class="bbc-nav-btn" data-page="about">说明与关于<i class="bbc-dot" hidden></i></button>
    </div>

    <div class="bbc-login" hidden>
      <div><b>还没登录 Boss 直聘</b><span>登录后才能打招呼、发消息。消息可以先编排好。</span></div>
      <span class="bbc-login-btns"><button class="bbc-primary bbc-sm" data-act="login">去登录</button>
        <button class="bbc-ghost bbc-sm" data-act="recheck">我已登录</button></span>
    </div>

    <div class="bbc-body">
      <div class="bbc-page" data-page="msg">
        <div class="bbc-bar bbc-jobs-only">
          <label class="bbc-switch"><input type="checkbox" data-k="sendSeq"><i></i><span>打招呼后，自动按顺序发送下面的消息</span></label>
        </div>
        <div class="bbc-greet bbc-jobs-only">
          <div class="bbc-greet-head"><span class="bbc-no bbc-no-0">0</span><b>Boss 自动打招呼语</b>
            <span class="bbc-greet-state"></span>
            <button class="bbc-icon" data-act="load-greet" title="重新读取">↻</button></div>
          <div class="bbc-foldbox"><span class="bbc-fold-text bbc-greet-text">读取中…</span><button class="bbc-fold-btn">展开 ▾</button></div>
          <div class="bbc-hint">点「立即沟通」时 Boss 会先自动发这句，之后才发下面的批量消息。修改请到 Boss App →「设置 → 打招呼语」。</div>
        </div>
        <div class="bbc-seq"></div>
        <div class="bbc-adds">
          <button class="bbc-add" data-act="add-text"><b>＋</b>文本消息</button>
          <button class="bbc-add" data-act="add-img"><b>＋</b>图片</button>
          <button class="bbc-add" data-act="goto-lib"><b>☰</b>从文本库选</button>
          <input type="file" accept="image/png,image/jpeg,image/jpg,image/gif" class="bbc-file" hidden multiple>
          <input type="file" accept="image/png,image/jpeg,image/jpg,image/gif" class="bbc-file-replace" hidden>
        </div>
        <div class="bbc-vars">
          <span class="bbc-hint">插入变量（发送时自动替换）：</span>
          <button class="bbc-chip" data-var="{公司}">公司</button>
          <button class="bbc-chip" data-var="{岗位}">岗位</button>
          <button class="bbc-chip" data-var="{HR}">HR</button>
          <button class="bbc-chip" data-var="{薪资}">薪资</button>
        </div>
        <div class="bbc-tip">每条消息<b>确认发送成功</b>才发下一条；同一个 HR <b>只发一次</b>，不会发错人。<span class="bbc-chat-only">点某条右上角的 ➤ 可以只发这一条给当前对话。</span></div>
      </div>

      <div class="bbc-page" data-page="sel">
        <div class="bbc-bar bbc-between">
          <span class="bbc-hint">在左侧职位卡片前打勾，按下面顺序逐个处理</span>
          <span><button class="bbc-ghost" data-act="all">全选本页</button><button class="bbc-ghost" data-act="clear2">全部取消</button></span>
        </div>
        <div class="bbc-lib bbc-sel-list"></div>
      </div>

      <div class="bbc-page" data-page="lib">
        <div class="bbc-sec-title"><span>我的文本库</span><span class="bbc-hint">在「批量消息」里点文本右上角的 <i class="bbc-star">☆</i> 存进来</span></div>
        <div class="bbc-lib bbc-lib-mine"></div>
        <div class="bbc-sec-title"><span>Boss 常用语</span>
          <button class="bbc-ghost" data-act="load-phrases">从 Boss 读取</button></div>
        <div class="bbc-lib bbc-lib-boss"></div>
      </div>

      <div class="bbc-page" data-page="rec">
        <div class="bbc-card">
          <div class="bbc-sec-title"><span>发送记录（防重复）</span>
            <button class="bbc-ghost" data-act="clear-sent">清空记录</button></div>
          <div class="bbc-sent-count bbc-big"></div>
          <div class="bbc-hint">已发过消息的 HR（名字+公司）不会再发第二次，清空后才会重新发。</div>
        </div>
        <div class="bbc-card">
          <div class="bbc-sec-title"><span>诊断（页面改版时用）</span></div>
          <div class="bbc-row"><button class="bbc-ghost" data-act="diag">4 秒后采集</button>
            <button class="bbc-ghost" data-act="diag-copy">复制诊断信息</button></div>
          <div class="bbc-hint">点「采集」后 4 秒内去打开要诊断的弹窗或常用语；发送确认失败时会自动采集。</div>
        </div>
      </div>

      <div class="bbc-page" data-page="about">
        <div class="bbc-about-hero">
          <span class="bbc-logo bbc-logo-lg">B</span>
          <div><b>Boss 批量沟通</b><span class="bbc-hint">自己挑职位，一键打招呼 + 按顺序发消息</span></div>
          <span class="bbc-ver">v…</span>
        </div>
        <div class="bbc-card">
          <div class="bbc-sec-title"><span>💡 发送时可以切走吗？</span></div>
          <div class="bbc-note">
            <p><b>建议：</b>开始发送前，把 Boss 这个标签页<b>拖出来单独成一个窗口</b>，再去别的窗口做事。窗口别最小化、电脑别休眠，这样最稳。</p>
            <p><b>切走也能跑：</b>插件已经做了<b>后台保活</b>，就算切到别的标签页，也会按正常节奏继续发送。</p>
            <p><b>保活原理：</b>Chrome 会把后台标签页里的计时拖慢（最慢一分钟才动一次）。插件发送期间：</p>
            <ul>
              <li>把「等几秒」交给一个不受后台限速的独立小线程来计时，时间到了叫醒页面；</li>
              <li>对 Chrome 声明「这个页面正在干活」，避免标签页被冻结；</li>
              <li>不让 Chrome 在内存紧张时把这个标签页自动卸载。</li>
            </ul>
            <p>发送结束后这些都会自动撤销，不影响平时使用，也不会让电脑一直保持唤醒。</p>
          </div>
          <div class="bbc-legend">
            <span><i class="bbc-done-badge bbc-wait">${CLOCK_ICON}</i>正在发送</span>
            <span><i class="bbc-done-badge bbc-done">✓</i>已发完</span>
            <span><i class="bbc-done-badge bbc-part">!</i>出错停下</span>
          </div>
          <div class="bbc-hint">职位卡片左上角的小标记含义。</div>
        </div>
        <div class="bbc-card">
          <div class="bbc-sec-title"><span>版本更新</span><button class="bbc-ghost" data-act="check-upd">检查更新</button></div>
          <div class="bbc-upd-state">还没检查</div>
          <pre class="bbc-upd-notes" hidden></pre>
          <div class="bbc-row bbc-upd-btns" hidden>
            <button class="bbc-primary bbc-sm" data-act="do-upd">一键更新</button>
            <a class="bbc-ghost bbc-upd-link" target="_blank" rel="noopener">查看更新说明</a>
          </div>
          <div class="bbc-hint">新版本发布在 GitHub，面板每 6 小时自动检查一次。</div>
        </div>
        <div class="bbc-card">
          <div class="bbc-sec-title"><span>开源地址</span></div>
          <a class="bbc-repo" href="${REPO_URL}" target="_blank" rel="noopener">${GH_ICON}<span>github.com/xiaoxing1617/boss-batch-chat</span><i>↗</i></a>
          <div class="bbc-links">
            <a class="bbc-ghost" href="${REPO_URL}" target="_blank" rel="noopener">⭐ 点个 Star</a>
            <a class="bbc-ghost" href="${REPO_URL}/issues" target="_blank" rel="noopener">反馈问题</a>
            <a class="bbc-ghost" href="${REPO_URL}#${encodeURIComponent('交流群')}" target="_blank" rel="noopener">加入交流群</a>
          </div>
          <div class="bbc-hint">免费开源（MIT 协议）。觉得好用请点个 Star，这是我继续更新的最大动力。</div>
        </div>
      </div>
    </div>

    <div class="bbc-foot">
      <div class="bbc-row bbc-jobs-only bbc-between">
        <span class="bbc-interval">每个职位间隔
          <input type="number" min="2" data-k="minSec"> – <input type="number" min="2" data-k="maxSec"> 秒</span>
        <span class="bbc-hint">单次最多 ${MAX_PER_RUN} 个</span>
      </div>
      <div class="bbc-cur bbc-chat-only">
        <span class="bbc-cur-label">当前对话</span><b class="bbc-cur-name">还没打开对话</b>
        <span class="bbc-cur-state"></span>
        <button class="bbc-ghost bbc-sm" data-act="forget-cur" hidden title="删掉这个人的发送记录，之后可以再发一次">移除记录</button>
      </div>
      <div class="bbc-row">
        <button class="bbc-primary bbc-jobs-only" data-act="start"></button>
        <button class="bbc-primary bbc-chat-only" data-act="send-cur" disabled>▶ 发送批量消息</button>
        <button class="bbc-danger" data-act="stop" disabled>停止</button>
      </div>
      <div class="bbc-log-wrap"><div class="bbc-log-title">运行日志</div><div class="bbc-log"></div></div>
    </div>`;
  document.body.appendChild(panel);
  panel.querySelectorAll('.bbc-jobs-only').forEach((el) => (el.style.display = onJobs ? '' : 'none'));
  panel.querySelectorAll('.bbc-chat-only').forEach((el) => (el.style.display = onChat ? '' : 'none'));

  const $ = (s) => panel.querySelector(s);
  const showPage = (p) => {
    panel.querySelectorAll('.bbc-nav-btn').forEach((b) => b.classList.toggle('bbc-active', b.dataset.page === p));
    panel.querySelectorAll('.bbc-page').forEach((pg) => (pg.style.display = pg.dataset.page === p ? '' : 'none'));
    refreshFolds();
  };
  // 长文本默认一行，超出时显示「展开 ▾ / 收起 ▴」
  function refreshFolds() {
    requestAnimationFrame(() =>
      panel.querySelectorAll('.bbc-foldbox').forEach((fb) => {
        const t = fb.querySelector('.bbc-fold-text');
        const b = fb.querySelector('.bbc-fold-btn');
        if (!t || !b || !t.offsetParent) return;
        const open = fb.classList.contains('bbc-open');
        b.hidden = !open && t.scrollWidth <= t.clientWidth + 1;
        b.textContent = open ? '收起 ▴' : '展开 ▾';
      })
    );
  }
  panel.addEventListener('click', (e) => {
    const fb = e.target.closest('.bbc-foldbox');
    if (!fb || !e.target.closest('.bbc-fold-text, .bbc-fold-btn')) return;
    if (fb.querySelector('.bbc-fold-btn')?.hidden && !fb.classList.contains('bbc-open')) return;
    fb.classList.toggle('bbc-open');
    refreshFolds();
  });
  panel.querySelectorAll('.bbc-nav-btn').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
  showPage('msg');

  // 顶部 1-2-3 步骤条：显示进度，点击跳到对应位置
  function refreshSteps() {
    if (!onJobs) return;
    const nSel = Object.keys(state.selected).length;
    const nMsg = state.seq.filter((m) => m.type === 'image' || m.text.trim()).length;
    const set = (k, done, sub) => {
      const el = $(`.bbc-step[data-step="${k}"]`);
      el.classList.toggle('bbc-done', done);
      el.querySelector('.bbc-step-sub').textContent = sub;
    };
    set(1, nSel > 0, `已选 ${nSel}`);
    set(2, nMsg > 0 || !state.sendSeq, state.sendSeq ? `${nMsg} 条` : '只打招呼');
    set(3, false, nSel ? '点底部按钮' : '先勾选职位');
  }
  panel.querySelectorAll('.bbc-step').forEach((b) =>
    b.addEventListener('click', () => {
      const g = b.dataset.goto;
      if (g !== 'start') return showPage(g);
      const btn = $('[data-act="start"]');
      btn.classList.remove('bbc-flash');
      void btn.offsetWidth;
      btn.classList.add('bbc-flash');
    })
  );
  const logBox = $('.bbc-log');
  const log = (msg) => {
    const t = new Date().toTimeString().slice(0, 8);
    logBox.textContent += `${t} ${msg}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  };
  // 所有按钮的处理函数都包一层：出错只写日志，不让面板卡死
  const safe = (fn) => async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      console.error('[Boss 批量沟通]', e);
      log('✗ 出错了：' + (e?.message || e));
    }
  };

  // 折叠 & 拖动
  const syncFold = () => {
    const c = panel.classList.contains('bbc-collapsed');
    $('.bbc-fold').textContent = c ? '＋' : '—';
    $('.bbc-fold').title = c ? '展开面板' : '收起成小条';
  };
  if (state.collapsed) panel.classList.add('bbc-collapsed');
  syncFold();
  if (state.pos) Object.assign(panel.style, { left: state.pos.x + 'px', top: state.pos.y + 'px', right: 'auto', bottom: 'auto' });
  $('.bbc-fold').addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('bbc-collapsed');
    state.collapsed = panel.classList.contains('bbc-collapsed');
    save();
    syncFold();
    refreshFolds();
  });
  // 一键回到右下角默认位置
  $('.bbc-home').addEventListener('click', (e) => {
    e.stopPropagation();
    state.pos = null;
    Object.assign(panel.style, { left: '', top: '', right: '', bottom: '' });
    save();
  });
  // 窗口变小时，别让面板跑到屏幕外面
  addEventListener('resize', () => {
    const r = panel.getBoundingClientRect();
    if (state.pos && (r.left > innerWidth - 80 || r.top > innerHeight - 40)) $('.bbc-home').click();
  });
  $('.bbc-head').addEventListener('mousedown', (e) => {
    if (e.target.closest('.bbc-hbtn')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => {
      const x = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 80);
      const y = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40);
      Object.assign(panel.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
      state.pos = { x, y };
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      save();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });

  // 简单设置项
  panel.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!state[k];
    else el.value = state[k];
    el.addEventListener('change', () => {
      state[k] = el.type === 'checkbox' ? el.checked : Math.max(2, +el.value || 2);
      if (state.maxSec < state.minSec) state.maxSec = state.minSec;
      save();
      refreshSteps();
      $('.bbc-seq').classList.toggle('bbc-off', !state.sendSeq);
    });
  });
  $('.bbc-seq').classList.toggle('bbc-off', !state.sendSeq);

  // ================= 消息序列编辑 =================
  const renderSeq = async () => {
    const box = $('.bbc-seq');
    box.innerHTML = '';
    for (const [i, m] of state.seq.entries()) {
      const row = document.createElement('div');
      row.className = 'bbc-msg bbc-msg-' + m.type;
      row.dataset.id = m.id;
      // 第一行：序号 + 类型 + 操作按钮；第二行：内容
      const head = `<div class="bbc-msg-head" title="长按这一行可拖动排序"><span class="bbc-grip">⠿</span><span class="bbc-no">${i + 1}</span>
          <span class="bbc-type">${m.type === 'text' ? '文本' : '图片'}</span>
          <span class="bbc-ops">
          <button class="bbc-icon" data-op="up" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="bbc-icon" data-op="down" title="下移" ${i === state.seq.length - 1 ? 'disabled' : ''}>↓</button>
          ${onChat ? '<button class="bbc-icon bbc-send1" data-op="send1" title="只把这一条发给当前对话">➤</button>' : ''}
          ${m.type === 'text' ? '<button class="bbc-icon bbc-star-btn" data-op="keep">☆</button>' : ''}
          <button class="bbc-icon bbc-icon-del" data-op="del" title="删除">✕</button></span></div>`;
      if (m.type === 'text') {
        row.innerHTML = `${head}<textarea rows="2" placeholder="输入要发送的文字，可点下方变量插入公司名等">${esc(m.text)}</textarea>`;
        row.querySelector('textarea').addEventListener('input', (e) => {
          m.text = e.target.value;
          save();
          refreshSteps();
          syncStar(row, m);
        });
        syncStar(row, m);
      } else {
        row.innerHTML = `${head}<div class="bbc-img-wrap"><img alt="" title="点击预览"><div class="bbc-img-info">
          <span class="bbc-img-name">${esc(m.name)}</span>
          <span class="bbc-img-btns"><button class="bbc-ghost bbc-sm" data-op="preview">预览</button><button class="bbc-ghost bbc-sm" data-op="replace">更换</button></span></div></div>`;
        const img = row.querySelector('img');
        img.addEventListener('click', () => img.src && preview(img.src));
        imgDB
          .get(m.id)
          .then((blob) => {
            if (blob) img.src = URL.createObjectURL(blob);
            else row.querySelector('.bbc-img-name').textContent = '（图片丢失，请点「更换」重新选择）';
          })
          .catch(() => (row.querySelector('.bbc-img-name').textContent = '（读取图片失败，请点「更换」重新选择）'));
      }
      row.querySelectorAll('[data-op]').forEach((b) =>
        b.addEventListener('click', () => {
          const op = b.dataset.op;
          if (op === 'preview') {
            const src = row.querySelector('img')?.src;
            return src ? preview(src) : log('这张图片读取不到，请点「更换」');
          }
          if (op === 'replace') {
            replaceTarget = m;
            return $('.bbc-file-replace').click();
          }
          if (op === 'send1') return safe(sendOne)(m);
          if (op === 'up' && i > 0) [state.seq[i - 1], state.seq[i]] = [state.seq[i], state.seq[i - 1]];
          if (op === 'down' && i < state.seq.length - 1) [state.seq[i + 1], state.seq[i]] = [state.seq[i], state.seq[i + 1]];
          if (op === 'del') {
            if (m.type === 'image') imgDB.del(m.id).catch(() => {});
            state.seq.splice(i, 1);
          }
          if (op === 'keep') {
            const t = m.text.trim();
            if (!t) return log('这条是空的，先写点内容再收藏');
            const k = state.library.indexOf(t);
            if (k >= 0) {
              state.library.splice(k, 1);
              log('已从文本库移出');
            } else {
              state.library.unshift(t);
              log('★ 已存到文本库');
            }
            renderLib();
          }
          save();
          if (op !== 'keep') renderSeq();
        })
      );
      box.appendChild(row);
    }
    if (!state.seq.length)
      box.innerHTML = '<div class="bbc-empty">还没有消息<br><span>点下面的「＋文本消息」或「＋图片」开始添加</span></div>';
    refreshSteps();
  };
  // 收藏星标：★ 已在文本库（点击移出）/ ☆ 没收藏（点击存入）
  function syncStar(row, m) {
    const b = row.querySelector('.bbc-star-btn');
    if (!b) return;
    const kept = !!m.text.trim() && state.library.includes(m.text.trim());
    b.textContent = kept ? '★' : '☆';
    b.classList.toggle('bbc-kept', kept);
    b.title = kept ? '已在文本库（点击移出）' : '存到文本库';
  }
  const refreshStars = () =>
    $('.bbc-seq')
      .querySelectorAll('.bbc-msg')
      .forEach((row) => {
        const m = state.seq.find((x) => x.id === row.dataset.id);
        if (m) syncStar(row, m);
      });

  // 图片预览（点空白处或按 Esc 关闭）
  function preview(src) {
    const ov = document.createElement('div');
    ov.className = 'bbc-lightbox';
    ov.innerHTML = `<img src="${src}" alt=""><span class="bbc-lb-close" title="关闭">✕</span>`;
    const close = () => {
      ov.remove();
      removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    ov.addEventListener('click', close);
    addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
  }
  let replaceTarget = null;

  // 长按消息卡片顶部那一行（约 0.3 秒）后拖动排序
  const enableDrag = () => {
    const box = $('.bbc-seq');
    const body = $('.bbc-body');
    box.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.bbc-msg-head');
      if (!head || e.target.closest('button') || running || e.button !== 0) return;
      const row = head.closest('.bbc-msg');
      const sx = e.clientX;
      const sy = e.clientY;
      let timer = null;
      const cancel = () => {
        clearTimeout(timer);
        removeEventListener('pointermove', pre);
        removeEventListener('pointerup', cancel);
        row.classList.remove('bbc-pressing');
      };
      const pre = (ev) => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) cancel(); // 按住时手抖太多就当普通点击
      };
      addEventListener('pointermove', pre);
      addEventListener('pointerup', cancel);
      row.classList.add('bbc-pressing');
      timer = setTimeout(() => {
        cancel();
        startDrag(row, sy);
      }, 300);
    });

    const startDrag = (row, y0) => {
      const from = [...box.children].indexOf(row);
      const rect = row.getBoundingClientRect();
      const ph = document.createElement('div');
      ph.className = 'bbc-ph';
      ph.style.height = rect.height + 'px';
      box.insertBefore(ph, row);
      Object.assign(row.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', zIndex: 100000, pointerEvents: 'none' });
      row.classList.add('bbc-dragging');
      const offset = y0 - rect.top;
      let scrollTimer = null;
      const move = (ev) => {
        row.style.top = ev.clientY - offset + 'px';
        let before = null;
        for (const c of box.children) {
          if (c === row || c === ph) continue;
          const r = c.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            before = c;
            break;
          }
        }
        box.insertBefore(ph, before);
        // 拖到列表边缘时自动滚动
        const b = body.getBoundingClientRect();
        clearInterval(scrollTimer);
        if (ev.clientY < b.top + 30) scrollTimer = setInterval(() => (body.scrollTop -= 8), 16);
        else if (ev.clientY > b.bottom - 30) scrollTimer = setInterval(() => (body.scrollTop += 8), 16);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        clearInterval(scrollTimer);
        const to = [...box.children].filter((c) => c !== row).indexOf(ph);
        const [m] = state.seq.splice(from, 1);
        state.seq.splice(to, 0, m);
        save();
        renderSeq();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    };
  };

  // 变量标签：插入到最后一次聚焦的文本框（没有就插到最后一条文本，或新建一条）
  let lastTA = null;
  $('.bbc-seq').addEventListener('focusin', (e) => {
    if (e.target.tagName === 'TEXTAREA') lastTA = e.target;
  });
  panel.querySelectorAll('[data-var]').forEach((chip) =>
    chip.addEventListener('click', () => {
      let ta = lastTA && lastTA.isConnected ? lastTA : [...$('.bbc-seq').querySelectorAll('textarea')].pop();
      if (!ta) {
        addText('');
        ta = [...$('.bbc-seq').querySelectorAll('textarea')].pop();
      }
      const v = chip.dataset.var;
      const s = ta.selectionStart ?? ta.value.length;
      const e2 = ta.selectionEnd ?? s;
      ta.value = ta.value.slice(0, s) + v + ta.value.slice(e2);
      ta.focus();
      ta.setSelectionRange(s + v.length, s + v.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })
  );
  const addText = (text = '') => {
    state.seq.push({ id: uid(), type: 'text', text });
    save();
    renderSeq();
  };
  $('[data-act="add-text"]').addEventListener('click', () => addText());
  $('[data-act="goto-lib"]').addEventListener('click', () => showPage('lib'));
  $('[data-act="add-img"]').addEventListener('click', () => $('.bbc-file').click());
  const okImage = (f) => {
    if (!/^image\/(png|jpe?g|gif)$/.test(f.type)) return log(`${f.name} 不是 png / jpg / gif 图片，已跳过`), false;
    if (f.size > 10 * 1024 * 1024) return log(`图片 ${f.name} 超过 10MB，已跳过`), false;
    return true;
  };
  $('.bbc-file').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      if (!okImage(f)) continue;
      const id = uid();
      try {
        await imgDB.put(id, f);
        state.seq.push({ id, type: 'image', name: f.name });
      } catch {
        log(`✗ 保存图片 ${f.name} 失败（浏览器存储被禁用或空间不足）`);
      }
    }
    e.target.value = '';
    save();
    renderSeq();
  });
  $('.bbc-file-replace').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    const m = replaceTarget;
    e.target.value = '';
    replaceTarget = null;
    if (!f || !m || !okImage(f)) return;
    try {
      await imgDB.put(m.id, f);
      m.name = f.name;
      save();
      renderSeq();
      log('✓ 图片已更换');
    } catch {
      log('✗ 更换失败（浏览器存储被禁用或空间不足）');
    }
  });

  const renderLibList = (sel, list, removable) => {
    const box = $(sel);
    box.innerHTML = list.length
      ? ''
      : `<div class="bbc-empty bbc-empty-sm">${removable ? '还没有存入的文本' : '点右上角「从 Boss 读取」'}</div>`;
    list.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = 'bbc-lib-item';
      item.innerHTML = `<div class="bbc-foldbox"><span class="bbc-fold-text">${esc(t)}</span><button class="bbc-fold-btn">展开 ▾</button></div>${
        onChat ? '<button class="bbc-ghost bbc-sm" data-op="ins" title="放进 Boss 输入框（不发送），可以改完再自己发">插入</button>' : ''
      }<button class="bbc-ghost bbc-sm" data-op="use" title="加入到批量消息末尾">＋ 加入</button>${
        removable ? '<button class="bbc-icon bbc-icon-del" data-op="del" title="从文本库删除">✕</button>' : ''
      }`;
      item.querySelector('[data-op="ins"]')?.addEventListener('click', () => insertToInput(t));
      item.querySelector('[data-op="use"]').addEventListener('click', () => {
        addText(t);
        log('✓ 已加入批量消息');
        showPage('msg');
        const body = $('.bbc-body');
        requestAnimationFrame(() => {
          body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
          const last = [...$('.bbc-seq').querySelectorAll('.bbc-msg')].pop();
          last?.classList.add('bbc-new');
          setTimeout(() => last?.classList.remove('bbc-new'), 1200);
        });
      });
      item.querySelector('[data-op="del"]')?.addEventListener('click', () => {
        list.splice(i, 1);
        save();
        renderLib();
      });
      box.appendChild(item);
    });
  };
  const renderLib = () => {
    renderLibList('.bbc-lib-mine', state.library, true);
    renderLibList('.bbc-lib-boss', state.phrases, false);
    refreshStars();
    refreshFolds();
  };

  // ================= 运行控制 =================
  let running = false;
  let sendingKey = null; // 正在处理的 HR（职位卡片上显示黄色时钟）
  let loggedIn = null; // 登录状态：null=还不知道 true=已登录 false=没登录
  // 后台保活②③：发送期间
  //  · 拿一把 Web Lock：Chrome 不会冻结持有锁的标签页；
  //  · 让扩展后台把这个标签页标成「不自动丢弃」：内存紧张时 Chrome 不会把它卸载掉，结束后恢复。
  let releaseLock = null;
  const keepAlive = (on) => {
    if (on && !releaseLock && navigator.locks)
      navigator.locks
        .request('bbc-sending', () => new Promise((r) => (releaseLock = r)))
        .catch(() => {});
    if (!on && releaseLock) {
      releaseLock();
      releaseLock = null;
    }
    if (window.top === window) extCall('keepAlive', { on }, 5000);
  };
  const setRunning = (on) => {
    running = on;
    keepAlive(on);
    sendingKey = null;
    panel.classList.toggle('bbc-running', on);
    $('[data-act="start"]').disabled = on;
    $('[data-act="send-cur"]').disabled = on;
    $('[data-act="stop"]').disabled = !on;
    if (!on) {
      progress.n = '';
      refreshCount();
    }
  };
  // 运行中：开始按钮变成实时播报，如「2/5 新诺电子 · 发第 3/4 条」
  const progress = { n: '', who: '' };
  const say = (what) => {
    if (!running) return;
    const btn = onJobs ? $('[data-act="start"]') : $('[data-act="send-cur"]');
    btn.textContent = `⏳ ${[progress.n, progress.who].filter(Boolean).join(' ')}${what ? ' · ' + what : ''}`;
  };
  $('[data-act="stop"]').addEventListener('click', () => {
    running = false;
    log('正在停止（当前这条发完就停）…');
  });
  const refreshCount = () => {
    const n = Object.keys(state.selected).length;
    $('.bbc-sent-count').textContent = `已记录 ${Object.keys(state.sentLog).length} 个 HR`;
    $('.bbc-count').textContent = onJobs ? `已选 ${n}` : '';
    if (onJobs) {
      if (!running)
        $('[data-act="start"]').textContent =
          loggedIn === false ? '🔒 请先登录 Boss 直聘' : n ? `▶ 开始逐个沟通（${n} 个职位）` : '▶ 开始逐个沟通';
      renderSelected();
      refreshSteps();
      refreshBadges();
    }
    if (onChat) refreshCur();
  };

  // 「已选」页：列出所有勾选，可以定位到卡片或单个取消
  function renderSelected() {
    $('.bbc-sel-n').textContent = Object.keys(state.selected).length;
    const box = $('.bbc-sel-list');
    const jobs = Object.values(state.selected);
    box.innerHTML = jobs.length ? '' : '<div class="bbc-empty">还没有勾选职位<br><span>在左侧职位卡片前面的方框里打勾</span></div>';
    jobs.forEach((job, i) => {
      const item = document.createElement('div');
      item.className = 'bbc-lib-item bbc-sel-item';
      item.innerHTML = `<i class="bbc-no">${i + 1}</i><span title="${esc(job.brandName + ' · ' + job.jobName + ' · ' + job.bossName)}"><b>${esc(job.brandName)}</b> · ${esc(job.jobName)}<em>${esc(job.bossName || '')}</em></span>
        <button class="bbc-ghost bbc-sm" data-op="go" title="滚动到这张卡片并打开详情">定位</button><button class="bbc-icon bbc-icon-del" data-op="del" title="取消勾选">✕</button>`;
      item.querySelector('[data-op="go"]').addEventListener('click', () => {
        const w = findWrap(job.id);
        if (!w) return log(`${job.brandName}·${job.jobName} 不在当前列表里`);
        w.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (!running) w.querySelector('li.job-card-box')?.click();
      });
      item.querySelector('[data-op="del"]').addEventListener('click', () => toggle(job, false));
      box.appendChild(item);
    });
  }

  // ================= 职位卡片勾选 =================
  const cardData = (wrap) => {
    const vm = wrap.__vue__;
    const d = vm && (vm.$props?.data || vm.data);
    if (!d || !d.encryptJobId) return null;
    return { id: d.encryptJobId, jobName: d.jobName, brandName: d.brandName, bossName: d.bossName, salaryDesc: d.salaryDesc };
  };
  const findWrap = (id) => [...document.querySelectorAll('.job-card-wrap')].find((w) => cardData(w)?.id === id);
  const setChecked = (wrap, on) => {
    const label = wrap?.querySelector('.bbc-check');
    if (!label) return;
    label.classList.toggle('bbc-on', on);
    label.querySelector('input').checked = on;
  };
  const toggle = (job, on, wrap) => {
    if (on) state.selected[job.id] = job;
    else delete state.selected[job.id];
    setChecked(wrap || findWrap(job.id), on);
    save();
    refreshCount();
  };
  // 职位卡片左上角的状态：
  //   正在处理 → 黄色时钟；发完 → 绿色 ✓；只发了一部分（出错停下）→ 红色 !
  const sentState = (job) => {
    if (running && sendingKey === hrKey(job)) return 'wait';
    const r = state.sentLog[hrKey(job)];
    if (!r) return null;
    return r.dup || r.sent >= r.total ? 'done' : 'part';
  };
  function refreshBadges() {
    document.querySelectorAll('.job-card-wrap').forEach((w) => {
      const box = w.querySelector('li.job-card-box');
      const job = cardData(w);
      if (!box || !job) return;
      const s = sentState(job);
      let b = box.querySelector('.bbc-done-badge');
      if (!s) return b?.remove();
      if (!b) {
        b = document.createElement('i');
        box.appendChild(b);
      }
      const r = state.sentLog[hrKey(job)];
      if (b.dataset.s !== s) {
        b.dataset.s = s;
        b.className = 'bbc-done-badge bbc-' + s;
        if (s === 'wait') b.innerHTML = CLOCK_ICON;
        else b.textContent = s === 'done' ? '✓' : '!';
      }
      b.title =
        s === 'wait'
          ? '正在给这个 HR 发送，请稍等' + (r ? `（已发 ${r.sent}/${r.total} 条）` : '')
          : s === 'done'
            ? '已给这个 HR 发过批量消息'
            : `出错停下了：只发出了 ${r.sent}/${r.total} 条`;
    });
  }
  const decorate = () => {
    document.querySelectorAll('.job-card-wrap').forEach((wrap) => {
      const box = wrap.querySelector('li.job-card-box');
      if (!box || box.querySelector('.bbc-check')) return;
      const job = cardData(wrap);
      if (!job) return;
      box.classList.add('bbc-has-check');
      const label = document.createElement('label');
      label.className = 'bbc-check';
      label.title = '选择这个职位';
      label.innerHTML = '<input type="checkbox">';
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggle(job, !state.selected[job.id], wrap);
      });
      box.appendChild(label);
      if (state.selected[job.id]) setChecked(wrap, true);
    });
  };

  // ================= 右侧 职位 / 沟通 tab =================
  let tabBar = null;
  let chatPane = null;
  let chatFrame = null;
  let activeTab = 'job';
  // 右侧详情卡片：优先用「立即沟通」按钮所在的详情容器（登录前后 class 可能不同）
  const detailEl = () =>
    document.querySelector('.job-detail-container') ||
    document.querySelector('.op-btn-chat')?.closest('[class*="job-detail"]') ||
    document.querySelector('[class*="job-detail"]');

  const placePane = () => {
    if (!chatPane || activeTab !== 'chat') return;
    const d = detailEl();
    const r = d?.getBoundingClientRect();
    const bar = tabBar?.isConnected ? tabBar.getBoundingClientRect() : null;
    let top, left, width;
    if (r && r.width > 200) {
      top = Math.max((bar && bar.height ? bar.bottom : r.top) + 4, 8);
      left = r.left;
      width = Math.max(r.width, 520);
    } else {
      // 找不到详情卡片时，固定显示在屏幕右侧
      top = 70;
      width = Math.min(640, innerWidth * 0.45);
      left = innerWidth - width - 440;
    }
    left = Math.max(8, Math.min(left, innerWidth - width - 8));
    Object.assign(chatPane.style, { top: top + 'px', left: left + 'px', width: width + 'px', height: innerHeight - top - 12 + 'px' });
    if (width !== lastPaneW) {
      lastPaneW = width;
      setTimeout(() => scrollRight(frameDoc()), 50);
    }
  };
  let lastPaneW = 0;
  // 嵌入的聊天页比较宽：滚到最右边，让聊天窗口露出来，能看到实时发送
  const scrollRight = (doc) => {
    try {
      const se = doc?.scrollingElement;
      if (se) se.scrollLeft = se.scrollWidth;
    } catch {}
  };
  const switchTab = (tab) => {
    activeTab = tab;
    tabBar?.querySelectorAll('.bbc-tab').forEach((b) => b.classList.toggle('bbc-active', b.dataset.tab === tab));
    if (tab === 'chat') {
      ensureChatFrame();
      chatPane.classList.remove('bbc-hidden');
      placePane();
    } else chatPane?.classList.add('bbc-hidden');
  };
  const mountTabs = () => {
    const d = detailEl();
    if (!d || (tabBar && tabBar.isConnected)) return;
    tabBar = document.createElement('div');
    tabBar.className = 'bbc-tabs';
    tabBar.innerHTML = `<button class="bbc-tab bbc-active" data-tab="job">职位</button>
      <button class="bbc-tab" data-tab="chat">沟通</button>`;
    tabBar.querySelectorAll('.bbc-tab').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        switchTab(b.dataset.tab);
      })
    );
    // 放在详情卡片「里面」的最上方（放外面会被卡片盖住看不到）
    d.insertBefore(tabBar, d.firstChild);
    switchTab(activeTab);
  };
  addEventListener('scroll', placePane, true);
  addEventListener('resize', placePane);

  const ensureChatFrame = () => {
    if (chatFrame) return;
    chatPane = document.createElement('div');
    chatPane.id = 'bbc-chat-pane';
    chatPane.className = 'bbc-hidden';
    chatFrame = document.createElement('iframe');
    chatFrame.src = '/web/geek/chat';
    chatFrame.addEventListener('load', () => [300, 1200, 2500].forEach((t) => setTimeout(() => scrollRight(frameDoc()), t)));
    chatPane.appendChild(chatFrame);
    document.body.appendChild(chatPane);
  };
  const frameDoc = () => {
    try {
      return chatFrame?.contentDocument;
    } catch {
      return null;
    }
  };
  const convItems = (doc) => [...doc.querySelectorAll('.user-list .friend-content')];
  const waitChatReady = async () => {
    ensureChatFrame();
    let why = '';
    const doc = await waitFor(() => {
      const d = frameDoc();
      if (!d) return null;
      const path = d.location.pathname;
      if (/\/web\/user|passport|login/.test(path)) return (why = 'login'), null;
      if (/verify|security|captcha/i.test(path)) return (why = 'verify'), null;
      return path.startsWith('/web/geek/chat') && convItems(d).length ? d : null;
    }, 25000);
    if (!doc && why === 'login') {
      setLogin(false);
      throw new Error('聊天页跳到了登录页：还没登录或登录已过期');
    }
    if (!doc && why === 'verify') throw new Error('Boss 要求安全验证，请在页面上手动完成验证后再试');
    return doc;
  };
  const reloadChat = async () => {
    const old = frameDoc();
    chatFrame.contentWindow.location.reload();
    await waitFor(() => frameDoc() !== old, 10000); // 等旧页面真正被替换，别拿到旧的 DOM
    return waitChatReady();
  };

  // 在聊天列表里找到这个 HR 的会话：HR 名字完全一致 且 公司名一致，两个都对上才算，绝不猜
  const convMatches = (el, job) =>
    !!el &&
    el.querySelector('.name-text')?.textContent.trim() === job.bossName &&
    !!el.querySelector('.name-box')?.textContent.includes(job.brandName);
  const findConv = (doc, job) => {
    const hits = convItems(doc).filter((el) => convMatches(el, job));
    return hits.length === 1 ? hits[0] : null; // 0 个或多个同名同公司都不发，避免发错人
  };
  // 当前打开的会话是不是这个人（每条消息发送前都要核对）
  const isRightConv = (doc, job) => convMatches(doc.querySelector('.user-list .friend-content.selected'), job);
  const searchConv = async (doc, job) => {
    const input = doc.querySelector('.boss-search-input');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, 'value').set;
    setter.call(input, job.bossName);
    input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    return waitFor(() => findConv(doc, job), 4000);
  };
  const openConv = async (job) => {
    let doc = await waitChatReady();
    if (!doc) throw new Error('聊天页没加载出来（可能没登录）');
    let item = await waitFor(() => findConv(doc, job), 3000);
    if (!item) {
      doc = await reloadChat(); // 新打的招呼有时要刷新才出现在列表里
      item = doc && (await waitFor(() => findConv(doc, job), 5000));
    }
    if (!item && doc) item = await searchConv(doc, job);
    if (!item) throw new Error(`聊天列表里找不到唯一匹配的 ${job.bossName}（${job.brandName}），为避免发错人已跳过`);
    item.scrollIntoView({ block: 'center' });
    item.click();
    scrollRight(doc);
    const ok = await waitFor(() => isRightConv(doc, job) && doc.querySelector('#chat-input'), 8000);
    if (!ok) throw new Error('会话没打开，或打开的不是这个人，已跳过');
    await sleep(rand(1200, 1800)); // 等聊天记录加载完，后面要用它判断是否发过
    if (!isRightConv(doc, job)) throw new Error('会话被切走了，已跳过');
    return doc;
  };

  // 发送记录：同一个 HR（名字+公司）只发一次消息序列，避免重复
  const hrKey = (job) => `${job.bossName}|${job.brandName}`;
  // 找这个人的发送记录：先按「名字|公司」精确找；聊天页上公司名可能写法不同，再用当前会话里的公司文字核对一次
  const sentRecord = (doc, job) => {
    const k = hrKey(job);
    if (state.sentLog[k]) return [k, state.sentLog[k]];
    const box = doc?.querySelector('.user-list .friend-content.selected .name-box')?.textContent || '';
    if (!box) return null;
    return Object.entries(state.sentLog).find(([key]) => {
      const [b, c] = key.split('|');
      return b === job.bossName && c && box.includes(c);
    }) || null;
  };
  const alreadySent = (doc, job) => {
    if (sentRecord(doc, job)) return '发送记录里已经给这个 HR 发过';
    const first = state.seq.find((m) => m.type === 'text' && m.text.trim());
    if (doc && first) {
      const head = fillTpl(first.text, job).replace(/\s+/g, '').slice(0, 20);
      if (head && myMsgs(doc).some((li) => li.textContent.replace(/\s+/g, '').includes(head)))
        return '聊天记录里已经有这条消息';
    }
    return null;
  };
  const markSent = (job, n, total, dup) => {
    state.sentLog[hrKey(job)] = { at: Date.now(), sent: n, total, ...(dup ? { dup: true } : {}) };
    save();
    refreshCount();
  };

  // 自己发出的消息
  const myMsgs = (doc) =>
    [...doc.querySelectorAll('.chat-record .im-list li.message-item')].filter(
      (li) => !li.classList.contains('item-friend') && !/item-system|item-tip/.test(li.className)
    );
  const msgFailed = (li) => /发送失败|重新发送|重发/.test(li.textContent) || !!li.querySelector('[class*="fail"], [class*="error"], [class*="resend"]');
  const msgPending = (li) => !!li.querySelector('[class*="loading"], [class*="sending"], [class*="uploading"]');
  // 发送前给已有消息拍个快照（按 data-mid + 元素本身），发送后找「快照里没有、且内容对得上」的那条
  const snapMsgs = (doc) => {
    const list = myMsgs(doc);
    return { els: new Set(list), mids: new Set(list.map((li) => li.dataset.mid).filter(Boolean)) };
  };
  const isNewMsg = (li, snap) => (li.dataset.mid ? !snap.mids.has(li.dataset.mid) : !snap.els.has(li));
  const waitSent = async (doc, snap, match, timeout) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await sleep(400);
      const fresh = myMsgs(doc).filter((li) => isNewMsg(li, snap) && match(li));
      if (!fresh.length) continue;
      const li = fresh[fresh.length - 1];
      if (msgFailed(li)) return 'fail';
      if (msgPending(li)) continue;
      await sleep(700); // 再确认一次没变成失败
      return msgFailed(li) ? 'fail' : 'ok';
    }
    return 'timeout';
  };

  const clickSend = (doc, input) => {
    const ctr = doc.querySelector('.message-controls') || doc;
    const btn = [...ctr.querySelectorAll('button, a, div, span')].find(
      (el) => isVisible(el) && el.children.length === 0 && /^发送$/.test(el.textContent.trim())
    );
    if (btn) return btn.click();
    const win = doc.defaultView;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new win.KeyboardEvent('keydown', opts));
    input.dispatchEvent(new win.KeyboardEvent('keypress', opts));
    input.dispatchEvent(new win.KeyboardEvent('keyup', opts));
  };

  // 文本里用到的变量读不到值（比如聊天页拿不到薪资）就不发，免得发出「我对的职位感兴趣」这种
  const VARS = { 公司: 'brandName', 岗位: 'jobName', HR: 'bossName', 薪资: 'salaryDesc' };
  const missingVars = (text, job) => Object.keys(VARS).filter((v) => text.includes(`{${v}}`) && !String(job[VARS[v]] || '').trim());
  const activeItems = () => state.seq.filter((m) => (m.type === 'text' ? m.text.trim() : true));

  const sendText = async (doc, job, text) => {
    const input = doc.querySelector('#chat-input');
    if (!input) return 'no-input';
    const snap = snapMsgs(doc);
    input.focus();
    doc.execCommand('selectAll', false, null);
    doc.execCommand('delete', false, null);
    doc.execCommand('insertText', false, text);
    await sleep(rand(400, 800));
    if (!isRightConv(doc, job)) {
      // 按发送前最后核对一次，不对就清空输入框不发
      input.focus();
      doc.execCommand('selectAll', false, null);
      doc.execCommand('delete', false, null);
      return 'wrong';
    }
    clickSend(doc, input);
    const head = text.replace(/\s+/g, '').slice(0, 12);
    return waitSent(doc, snap, (li) => li.textContent.replace(/\s+/g, '').includes(head), 15000);
  };

  const sendImage = async (doc, job, blob, name) => {
    const input = doc.querySelector('.btn-sendimg input[type="file"]');
    if (!input) return 'no-input';
    if (!isRightConv(doc, job)) return 'wrong';
    const win = doc.defaultView;
    const snap = snapMsgs(doc);
    const file = new win.File([blob], name || 'image.png', { type: blob.type || 'image/png' });
    const dt = new win.DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    // 有的版本会弹「发送图片」确认框
    const confirm = await waitFor(
      () => findByText(doc, '.dialog-container button, .dialog-container .btn, .dialog-footer span, .dialog-footer a', /^(发送|确定|确认)$/),
      2000
    );
    if (confirm) confirm.click();
    return waitSent(doc, snap, (li) => !!li.querySelector('.message-content img:not(.image-circle), img[class*="img"]:not(.image-circle)'), 40000);
  };

  // 按顺序发送整个消息序列：一条确认成功才发下一条
  // 返回 'ok' | 'dup'（发过了，跳过）| 'fail' | 'stopped'
  const sendSeq = async (job) => {
    const items = activeItems();
    if (!items.length) {
      log('  批量消息是空的，跳过发消息');
      return 'ok';
    }
    const dupWhy = alreadySent(null, job);
    if (dupWhy) {
      log(`  ⏭ ${dupWhy}，不重复发送`);
      return 'dup';
    }
    say('打开会话');
    switchTab('chat');
    const doc = await openConv(job);
    return sendItemsTo(doc, job, items);
  };
  // 在已打开的会话里按顺序发 items。dup=检查是否发过；record=记入发送记录
  const sendItemsTo = async (doc, job, items, { dup = true, record = true } = {}) => {
    const miss = new Set();
    items.forEach((m) => m.type === 'text' && missingVars(m.text, job).forEach((v) => miss.add(v)));
    if (miss.size) {
      const vs = [...miss].map((v) => '{' + v + '}').join(' ');
      log(`  ✗ 读不到 ${vs} 的值，没有发送（免得发出缺字的消息）。${onChat ? '可以去职位列表页发，或' : '可以'}把批量消息里的 ${vs} 改成具体文字`);
      return 'fail';
    }
    if (dup) {
      const why = alreadySent(doc, job);
      if (why) {
        log(`  ⏭ ${why}，不重复发送`);
        if (record && !sentRecord(doc, job)) markSent(job, 0, items.length, true);
        return 'dup';
      }
    }
    if (!navigator.onLine) {
      log('  ✗ 网络断开了，没有发送');
      return 'fail';
    }
    for (const [i, m] of items.entries()) {
      if (!running) return 'stopped';
      if (!isRightConv(doc, job)) {
        log(`  ✗ 当前会话已经不是 ${job.bossName}，立即停止，避免发错人`);
        return 'fail';
      }
      let r;
      say(`发第 ${i + 1}/${items.length} 条${m.type === 'text' ? '' : '（图片）'}`);
      if (m.type === 'text') r = await sendText(doc, job, fillTpl(m.text, job));
      else {
        const blob = await imgDB.get(m.id).catch(() => null);
        if (!blob) {
          log(`  ✗ 第 ${i + 1} 条图片丢失，停止给 ${job.bossName} 发送`);
          return 'fail';
        }
        r = await sendImage(doc, job, blob, m.name);
      }
      if (r !== 'ok') {
        const why =
          { fail: '发送失败', timeout: '等了很久没确认发送成功', 'no-input': '找不到输入框/图片按钮', wrong: '会话不是这个人了' }[r] || r;
        log(`  ✗ 第 ${i + 1} 条${m.type === 'text' ? '文本' : '图片'}：${why}，停止给 ${job.bossName} 发后面的消息`);
        if (record && (r === 'timeout' || r === 'fail')) {
          // 消息可能其实已经发出去了：记入发送记录，宁可漏发也不重复发
          markSent(job, i, items.length);
          state.diag = JSON.stringify([{ reason: r, step: i + 1, type: m.type }, collectDiag(doc, 'chat-frame')], null, 1);
          save();
          log('  已自动采集诊断信息，可在「记录」页点「复制诊断信息」发给开发者');
        }
        return 'fail';
      }
      if (record) markSent(job, i + 1, items.length); // 发出一条就记下，之后不会再给这个人重复发
      log(`  ✓ 第 ${i + 1}/${items.length} 条${m.type === 'text' ? '文本' : '图片'}已发送`);
      if (i < items.length - 1) await sleep(rand(1500, 3000));
    }
    return 'ok';
  };

  // 点了「立即沟通」之后的结果
  const waitGreetResult = async (btn) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      await sleep(300);
      const login = document.querySelector('.login-dialog, [class*="login-dialog"], .boss-login-dialog, .sign-form');
      if (isVisible(login)) return 'login';
      const limit = findByText(document, '[class*="toast"], [class*="dialog"], [class*="tip"]', /上限|频繁|稍后再试|安全验证|验证码|账号异常/);
      if (limit) return 'limit:' + limit.textContent.trim().slice(0, 40);
      const stay = findByText(document, 'a, button, span, div', /^留在此页$/);
      if (stay) {
        stay.click();
        return 'ok';
      }
      if (/继续沟通/.test(btn.textContent)) return 'ok';
    }
    return 'timeout';
  };

  // 处理一个职位：没沟通过先打招呼，然后发消息序列
  const processJob = async (job) => {
    const wrap = findWrap(job.id);
    if (!wrap) {
      log(`跳过 ${job.brandName}·${job.jobName}：列表里找不到了（翻页或刷新过）`);
      return 'skip';
    }
    progress.who = job.brandName;
    say('打开职位');
    switchTab('job');
    wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(500, 1000));
    wrap.querySelector('li.job-card-box').click();
    const btn = await waitFor(() => document.querySelector(`.job-detail-container .op-btn-chat[ka$="${job.id}"]`));
    if (!btn) {
      log(`跳过 ${job.brandName}·${job.jobName}：详情没加载出来`);
      return 'skip';
    }
    log(`▶ ${job.brandName}·${job.jobName}（${job.bossName}）`);
    if (/立即沟通/.test(btn.textContent)) {
      say('打招呼');
      await sleep(rand(600, 1400));
      btn.click();
      const r = await waitGreetResult(btn);
      if (r === 'login') return setLogin(false), log('✗ 还没登录 Boss，请先登录'), 'abort';
      if (r.startsWith('limit')) return log('✗ 被限制了：' + r.slice(6)), 'abort';
      if (r !== 'ok') return log('  ? 没看到打招呼成功的提示，跳过'), 'skip';
      log('  ✓ 已打招呼');
      await sleep(rand(1500, 2500));
    } else {
      log('  已沟通过，直接发消息');
    }
    if (!state.sendSeq) return 'ok';
    try {
      const r = await sendSeq(job);
      return r === 'ok' || r === 'dup' ? 'ok' : r === 'stopped' ? 'stopped' : 'partial';
    } catch (e) {
      log('  ✗ ' + e.message);
      return 'partial';
    }
  };

  const runAll = async () => {
    let jobs = Object.values(state.selected);
    if (!jobs.length) return log('请先在职位卡片左侧勾选要沟通的职位');
    if (jobs.length > MAX_PER_RUN) {
      log(`一次最多 ${MAX_PER_RUN} 个，本次只处理前 ${MAX_PER_RUN} 个`);
      jobs = jobs.slice(0, MAX_PER_RUN);
    }
    if (!(await ensureLogin())) return;
    if (!navigator.onLine) return log('✗ 网络断开了，请联网后再试');
    setRunning(true);
    let ok = 0;
    try {
      for (const [i, job] of jobs.entries()) {
        if (!running) break;
        progress.n = `${i + 1}/${jobs.length}`;
        let r;
        sendingKey = hrKey(job);
        refreshBadges();
        try {
          r = await processJob(job);
        } catch (e) {
          log('  ✗ ' + (e?.message || e));
          r = 'skip';
          if (/登录/.test(e?.message)) r = 'abort';
        } finally {
          sendingKey = null;
          refreshBadges();
        }
        if (r === 'abort') break;
        if (r === 'ok') {
          ok++;
          toggle(job, false);
        }
        const done = { ok: '完成 ✓', stopped: '已停止', partial: '没发完' }[r] || '已跳过';
        say(done);
        if (running && i < jobs.length - 1) {
          const wait = Math.round(rand(state.minSec, state.maxSec));
          log(`  等待 ${wait} 秒…`);
          for (let s = wait; s > 0 && running; s--) {
            say(`${done}，${s} 秒后下一个`);
            await sleep(1000);
          }
        }
      }
      log(`全部结束：完整完成 ${ok} / ${jobs.length} 个`);
    } finally {
      switchTab('job');
      setRunning(false);
    }
  };

  // ================= 聊天页（/web/geek/chat）=================
  // 尽量从会话的 Vue 数据里拿岗位、薪资（拿不到就留空，发送前会检查变量）
  const vueJobData = (el) => {
    for (let e = el, d = 0; e && d < 6; e = e.parentElement, d++) {
      const vm = e.__vue__;
      if (!vm) continue;
      for (const src of [vm.$props, vm.$data]) {
        for (const v of Object.values(src || {})) {
          if (v && typeof v === 'object' && ('jobName' in v || 'positionName' in v || 'brandName' in v))
            return { jobName: v.jobName || v.positionName || '', salaryDesc: v.salaryDesc || '' };
        }
      }
    }
    return null;
  };
  // 当前打开的会话是谁：名字取 .name-text，公司取名字后面的那一段
  const chatJobOf = (doc) => {
    const el = doc.querySelector('.user-list .friend-content.selected');
    const bossName = el?.querySelector('.name-text')?.textContent.trim();
    if (!bossName) return null;
    const parts = [...(el.querySelector('.name-box')?.children || [])]
      .filter((c) => !c.classList.contains('name-text'))
      .map((c) => c.textContent.trim())
      .filter(Boolean);
    let vd = null;
    try {
      vd = vueJobData(el);
    } catch {}
    return { bossName, brandName: parts[0] || '', jobName: vd?.jobName || '', salaryDesc: vd?.salaryDesc || '' };
  };
  let curJob = null;
  function refreshCur() {
    if (!onChat) return;
    const job = chatJobOf(document);
    curJob = job;
    const st = $('.bbc-cur-state');
    const btn = $('[data-act="send-cur"]');
    const fb = $('[data-act="forget-cur"]');
    if (!job) {
      $('.bbc-cur-name').textContent = '还没打开对话，先在左边点一个人';
      st.textContent = '';
      fb.hidden = true;
      if (!running) btn.disabled = true;
      if (!running) btn.textContent = '▶ 发送批量消息';
      return;
    }
    $('.bbc-cur-name').textContent = job.bossName + (job.brandName ? ' · ' + job.brandName : '');
    const rec = sentRecord(document, job);
    st.textContent = rec ? (rec[1].dup || rec[1].sent >= rec[1].total ? '已发过' : `已发 ${rec[1].sent}/${rec[1].total}`) : '未发过';
    st.className = 'bbc-cur-state ' + (rec ? 'bbc-off' : 'bbc-on');
    fb.hidden = !rec;
    if (!running) {
      btn.disabled = !!rec || loggedIn === false;
      btn.textContent = rec ? '已给 TA 发过（防重复）' : `▶ 发送批量消息给 ${job.bossName}`;
    }
  }
  async function sendToChat() {
    const job = chatJobOf(document);
    if (!job) return log('请先在左边点开一个对话');
    if (!document.querySelector('#chat-input')) return log('✗ 没找到输入框，等对话加载完再试');
    const items = activeItems();
    if (!items.length) return log('批量消息是空的，先在上面添加');
    if (!(await ensureLogin())) return;
    if (!job.brandName) log('提示：没读到这个人的公司名，只按名字核对会话');
    setRunning(true);
    progress.n = '';
    progress.who = job.bossName;
    log(`▶ 给 ${job.bossName}${job.brandName ? '（' + job.brandName + '）' : ''} 发送批量消息`);
    try {
      const r = await sendItemsTo(document, job, items);
      if (r === 'ok') log('  ✓ 全部发送完成');
      else if (r !== 'dup') log('  已中止');
    } finally {
      setRunning(false);
    }
  }
  // 只发某一条（聊天页上每条消息右上角的 ➤），不查重、不记入发送记录
  async function sendOne(m) {
    if (running) return log('正在发送中，请等当前任务结束');
    const job = chatJobOf(document);
    if (!job) return log('请先在左边点开一个对话');
    if (m.type === 'text' && !m.text.trim()) return log('这条是空的');
    if (!(await ensureLogin())) return;
    setRunning(true);
    progress.n = '';
    progress.who = job.bossName;
    log(`▶ 单条发送给 ${job.bossName}`);
    try {
      const r = await sendItemsTo(document, job, [m], { dup: false, record: false });
      if (r === 'ok') log('  ✓ 已发送');
    } finally {
      setRunning(false);
    }
  }
  // 文本库「插入」：放进 Boss 输入框，不发送
  function insertToInput(text) {
    const input = document.querySelector('#chat-input');
    if (!input) return log('请先在左边点开一个对话');
    const job = chatJobOf(document) || {};
    let t = text;
    for (const [v, k] of Object.entries(VARS)) if (job[k]) t = t.split(`{${v}}`).join(job[k]);
    input.focus();
    document.execCommand('insertText', false, t);
    if (/\{(公司|岗位|HR|薪资)\}/.test(t)) log('已插入（有变量读不到值，请手动改一下再发）');
    else log('✓ 已插入输入框，确认后自己点发送');
  }

  // ================= 登录状态 =================
  // null=还不知道 true=已登录 false=没登录
  function setLogin(v) {
    loggedIn = v;
    $('.bbc-login').hidden = v !== false;
    panel.classList.toggle('bbc-nologin', v === false);
    refreshCount();
  }
  const checkLogin = async () => {
    try {
      const res = await fetch('/wapi/zpuser/wap/getUserInfo.json?_=' + Date.now(), {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const json = await res.json();
      if (json.code === 0 && json.zpData) return setLogin(true), true;
      if (json.code === 7 || json.code === 17 || /登录/.test(json.message || '')) return setLogin(false), false;
    } catch {}
    // 接口不可用时看页面：右上角有「登录」按钮且没有头像，就当没登录
    const signBtn = findByText(document, '#header a, .header a, [class*="header"] a', /^(登录|登录\/注册|注册\/登录)$/);
    const avatar = document.querySelector('#header .nav-figure, .user-nav .nav-figure, [class*="header"] img[class*="avatar"]');
    if (signBtn && !avatar) return setLogin(false), false;
    setLogin(avatar ? true : null);
    return loggedIn !== false;
  };
  const ensureLogin = async () => {
    const ok = await checkLogin();
    if (!ok) log('✗ 还没登录 Boss 直聘，请先点面板上方的「去登录」');
    return ok;
  };
  $('[data-act="login"]').addEventListener('click', () => {
    const btn = findByText(document, '#header a, .header a, [class*="header"] a, [class*="header"] button', /登录/);
    if (btn) btn.click();
    else location.href = '/web/user/?ka=header-login';
  });
  $('[data-act="recheck"]').addEventListener(
    'click',
    safe(async () => {
      if (await checkLogin()) {
        log('✓ 已登录');
        if (onJobs) loadGreeting();
      } else log('还是没检测到登录，登录后刷新一下页面试试');
    })
  );
  // 切回这个标签页时重新检测（可能在别的页面登录了）
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && loggedIn === false && checkLogin());

  // ================= 版本更新（通过扩展后台读取 GitHub 发布） =================
  // main.js 在页面主环境里用不了扩展接口，通过 bridge.js 转发
  const extCall = (type, data, timeout = 20000) =>
    new Promise((resolve) => {
      const id = uid();
      const on = (e) => {
        if (e.source !== window || e.data?.source !== 'bbc-ext' || e.data.id !== id) return;
        removeEventListener('message', on);
        clearTimeout(t);
        resolve(e.data.result || { error: '没有返回结果' });
      };
      const t = setTimeout(() => {
        removeEventListener('message', on);
        resolve({ error: '连接不上扩展，请刷新页面' });
      }, timeout);
      addEventListener('message', on);
      window.postMessage({ source: 'bbc-page', id, type, data }, location.origin);
    });
  let updInfo = null;
  const showUpd = (r) => {
    const st = $('.bbc-upd-state');
    const notes = $('.bbc-upd-notes');
    $('.bbc-upd-btns').hidden = true;
    notes.hidden = true;
    $('.bbc-dot').hidden = true;
    if (r.error) {
      st.textContent = '检查失败：' + r.error;
      st.className = 'bbc-upd-state bbc-off';
      return;
    }
    if (r.current) $('.bbc-ver').textContent = 'v' + r.current;
    if (!r.latest) {
      st.textContent = '还没有发布任何版本';
      st.className = 'bbc-upd-state';
      return;
    }
    if (r.hasUpdate) {
      st.textContent = `发现新版本 v${r.latest}（当前 v${r.current}）`;
      st.className = 'bbc-upd-state bbc-new-ver';
      $('.bbc-upd-btns').hidden = false;
      $('[data-act="do-upd"]').textContent = `一键更新到 v${r.latest}`;
      $('.bbc-upd-link').href = r.url || REPO_URL + '/releases/latest';
      $('.bbc-dot').hidden = false;
      if (r.notes) {
        notes.textContent = r.notes;
        notes.hidden = false;
      }
    } else {
      st.textContent = `已经是最新版本 ✓（v${r.current}）`;
      st.className = 'bbc-upd-state bbc-on';
    }
  };
  const checkUpd = async (force) => {
    $('.bbc-upd-state').textContent = '正在检查…';
    $('.bbc-upd-state').className = 'bbc-upd-state';
    const r = await extCall('checkUpdate', { force });
    updInfo = r;
    showUpd(r);
    if (r.hasUpdate && state.updNotified !== r.latest) {
      state.updNotified = r.latest;
      save();
      log(`🎉 发现新版本 v${r.latest}，在「关于」页可以一键更新`);
    }
    return r;
  };
  $('[data-act="check-upd"]').addEventListener('click', safe(() => checkUpd(true)));
  $('[data-act="do-upd"]').addEventListener(
    'click',
    safe(async () => {
      if (running) return log('正在发送中，请等任务结束或点「停止」后再更新');
      const r = await extCall('openUpdater');
      if (r.error) return log('✗ 打开更新页失败：' + r.error);
      log('已在新标签页打开更新页面，按提示操作即可');
    })
  );

  // ================= Boss 打招呼语（只读） =================
  // 「立即沟通」时 Boss 自动发出的第一句话，来自用户在 Boss 里设置的打招呼语
  const loadGreeting = async () => {
    const box = $('.bbc-greet-text');
    const st = $('.bbc-greet-state');
    box.textContent = '读取中…';
    st.textContent = '';
    try {
      const bst = (document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('bst=')) || '').slice(4);
      let token = bst;
      try {
        token = decodeURIComponent(bst);
      } catch {}
      const res = await fetch('/wapi/zpchat/greeting/getGreetingList?_=' + Date.now(), {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest', ...(token ? { zp_token: token } : {}) },
      });
      const json = await res.json();
      if (json.code !== 0 || !json.zpData) throw new Error(json.message || '接口返回异常');
      const g = json.zpData.greeting || {};
      const list = json.zpData.greetingTemplateList || [];
      const cur = list.find((t) => String(t.templateId) === String(g.templateId));
      const text = String(cur?.demo || cur?.content || g.demo || g.content || '').trim();
      const on = Number(g.status) === 1;
      st.textContent = on ? '已开启' : '未开启';
      st.className = 'bbc-greet-state ' + (on ? 'bbc-on' : 'bbc-off');
      box.textContent = text || '（没读到内容）';
      refreshFolds();
      state.greeting = { on, text, at: Date.now() };
      save();
      if (!on) log('提示：你的 Boss 打招呼语没有开启，「立即沟通」后可能不会自动发第一句');
    } catch (e) {
      st.textContent = '读取失败';
      st.className = 'bbc-greet-state bbc-off';
      box.textContent = state.greeting?.text
        ? state.greeting.text + '（上次读取）'
        : loggedIn === false
          ? '登录后才能读取'
          : '读取失败，点 ↻ 重试';
      refreshFolds();
    }
  };

  // ================= Boss 常用语 =================
  const loadPhrases = async () => {
    if (onJobs) switchTab('chat');
    log('正在读取 Boss 常用语…');
    const doc = onChat ? document : await waitChatReady();
    if (!doc) return log('✗ 聊天页没加载出来（可能没登录）');
    if (!doc.querySelector('#chat-input')) {
      const first = convItems(doc)[0];
      if (!first) return log('✗ 你还没有任何会话，没法打开常用语');
      first.click();
      if (!(await waitFor(() => doc.querySelector('#chat-input'), 6000))) return log('✗ 打开会话失败');
      await sleep(800);
    }
    const ctr = doc.querySelector('.chat-controls') || doc.querySelector('.message-controls');
    const attrText = (e) => [...e.attributes].map((a) => a.value).join(' ');
    const btn = [...(ctr?.querySelectorAll('*') || [])].find(
      (e) => /常用语|dict|phrase|common-word|quick-reply|fast-reply/i.test(attrText(e) + ' ' + (e.children.length ? '' : e.textContent))
    );
    if (!btn) {
      const names = [...(ctr?.querySelectorAll('.toolbar-btn-content, [class*="btn"]') || [])].map((e) => e.className).join(' | ');
      log('✗ 没找到常用语按钮。工具栏按钮：' + names.slice(0, 300));
      return;
    }
    const before = new Set([...doc.querySelectorAll('body *')].filter(isVisible));
    btn.click();
    await sleep(1200);
    const fresh = [...doc.querySelectorAll('body *')].filter((e) => isVisible(e) && !before.has(e));
    const texts = [];
    for (const e of fresh) {
      if (e.tagName !== 'LI' && e.children.length) continue;
      const t = e.textContent.trim();
      if (t.length < 4 || t.length > 300) continue;
      if (/^(添加|编辑|管理|设置|常用语|取消|确定|删除|新增|保存)/.test(t)) continue;
      if (!texts.some((x) => x.includes(t) || t.includes(x))) texts.push(t);
    }
    // 关掉常用语面板
    doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (isVisible(fresh[0])) btn.click();
    if (!texts.length) return log('✗ 常用语面板打开了但没读到内容，可以用「诊断」采集一下发给开发者');
    state.phrases = texts;
    save();
    renderLib();
    showPage('lib');
    log(`✓ 读到 ${texts.length} 条常用语`);
  };

  // ================= 诊断 =================
  const collectDiag = (doc, tag) => {
    const cls = (e) => (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '');
    const sig = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + cls(e);
    const pathOf = (e) => {
      const a = [];
      while (e && e !== doc.body && a.length < 6) {
        a.unshift(sig(e));
        e = e.parentElement;
      }
      return a.join(' > ');
    };
    const short = (s, n = 1200) => (s || '').replace(/\s+/g, ' ').slice(0, n);
    const mine = (e) => !e.closest('#bbc-panel, .bbc-tabs, #bbc-chat-pane');
    const out = { where: tag, url: doc.location.href };
    out.toolbar = [...doc.querySelectorAll('.chat-controls *')]
      .filter((e) => e.children.length <= 1)
      .slice(0, 40)
      .map((e) => sig(e) + ' | ' + [...e.attributes].map((a) => a.name + '=' + a.value).join(' ').slice(0, 160));
    out.dialogs = [...doc.querySelectorAll('[class*="dialog"], [class*="popover"], [class*="pop"], [class*="panel"], [class*="drawer"]')]
      .filter((e) => isVisible(e) && mine(e))
      .slice(0, 6)
      .map((e) => pathOf(e) + '\n' + short(e.outerHTML, 1500));
    out.myLastMessages = myMsgs(doc).slice(-3).map((e) => short(e.outerHTML, 1500));
    out.sendBtn = [...doc.querySelectorAll('.message-controls *')]
      .filter((e) => e.children.length === 0 && /发送/.test(e.textContent))
      .map(pathOf);
    return out;
  };
  $('[data-act="diag"]').addEventListener('click', async () => {
    log('4 秒后采集，现在可以去打开要诊断的弹窗或常用语…');
    await sleep(4000);
    const res = [collectDiag(document, 'top')];
    const fd = frameDoc();
    if (fd) res.push(collectDiag(fd, 'chat-frame'));
    state.diag = JSON.stringify(res, null, 1);
    save();
    log('✓ 已采集，点「复制诊断信息」');
  });
  $('[data-act="diag-copy"]').addEventListener('click', async () => {
    if (!state.diag) return log('还没采集');
    try {
      await navigator.clipboard.writeText(state.diag);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = state.diag;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    log('✓ 已复制到剪贴板');
  });

  // ================= 启动 =================
  $('[data-act="start"]').addEventListener('click', safe(runAll));
  $('[data-act="send-cur"]').addEventListener('click', safe(sendToChat));
  $('[data-act="forget-cur"]').addEventListener('click', () => {
    const job = chatJobOf(document);
    const rec = job && sentRecord(document, job);
    if (!rec || !confirm(`删掉 ${job.bossName} 的发送记录后，可以再给 TA 发一次批量消息。确定？`)) return;
    delete state.sentLog[rec[0]];
    save();
    refreshCount();
    log(`已移除 ${job.bossName} 的发送记录`);
  });
  $('[data-act="clear-sent"]').addEventListener('click', () => {
    if (!confirm('清空后，之前发过消息的 HR 会被再次发送。确定清空？')) return;
    state.sentLog = {};
    save();
    refreshCount();
    log('发送记录已清空');
  });
  $('[data-act="load-phrases"]').addEventListener('click', safe(loadPhrases));
  $('[data-act="load-greet"]').addEventListener('click', safe(loadGreeting));
  $('[data-act="all"]').addEventListener('click', () => {
    document.querySelectorAll('.job-card-wrap').forEach((w) => {
      const job = cardData(w);
      if (job) toggle(job, true, w);
    });
  });
  const clearSelected = () => {
    state.selected = {};
    save();
    document.querySelectorAll('.job-card-wrap').forEach((w) => setChecked(w, false));
    refreshCount();
  };
  $('[data-act="clear2"]').addEventListener('click', clearSelected);

  refreshCount();
  renderSeq();
  renderLib();
  enableDrag();
  checkLogin().then(() => onJobs && loadGreeting());
  extCall('info', null, 4000).then((r) => r.version && ($('.bbc-ver').textContent = 'v' + r.version));
  setTimeout(() => checkUpd(false), 3000); // 页面加载完再检查（6 小时内用缓存，不会频繁请求 GitHub）
  if (onChat) setInterval(() => !running && refreshCur(), 1000); // 跟着用户点的会话更新「当前对话」
  if (onJobs) {
    decorate();
    refreshBadges();
    mountTabs();
    let t = null;
    new MutationObserver((muts) => {
      if (muts.every((m) => panel.contains(m.target))) return;
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          decorate();
          refreshBadges();
          mountTabs();
          placePane();
        } catch (e) {
          console.error('[Boss 批量沟通]', e);
        }
      }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
