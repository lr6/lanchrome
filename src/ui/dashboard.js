/* 关注整理所 — 控制台 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const FIXED_INTERVALS = {
  pageDelayMs: 1500,
  lookupDelayMs: 1500,
  unfollowMinDelayMs: 4000,
  unfollowMaxDelayMs: 8000,
};

const DEFAULT_SETTINGS = {
  ...FIXED_INTERVALS,
  limitDefault: 1000,
};

const FILTERS = {
  notFollowingBack: { label: '未回关我' },
  notFollowedByMe: { label: '我未回关' },
  mutual: { label: '互关' },
  protected: { label: '特别关注' },
  all: { label: '全部' },
};

const PAGE_TITLES = {
  overview: ['概览', '把关注理清楚，把时间留给值得的人。'],
  relations: ['关系名单', '分清谁未回关我、我未回关谁。'],
  protect: ['特别关注', '这些人批量清理时自动保留。'],
  backup: ['备份与恢复', '本机数据，随时带走。'],
  settings: ['设置', '节奏放慢一点，走得更远。'],
};

const state = {
  accounts: [],
  account: null,
  relations: {},
  protectedMap: {},
  history: [],
  task: null,
  scan: null,
  settings: { ...DEFAULT_SETTINGS },
  captures: null,
  route: 'overview',
  filter: 'notFollowingBack',
  search: '',
  page: 1,
  pageSize: 50,
  selected: new Set(),
  busy: false,
  currentPageKey: '',
  selfTestReport: null,
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const pad = (x) => String(x).padStart(2, '0');
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function send(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: '没有响应' });
    });
  });
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function parseHandle(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  const urlMatch = value.match(/(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
  if (urlMatch) return urlMatch[1];
  value = value.replace(/^@+/, '').split(/[\s?/#]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(value) ? value : '';
}

function avatarHtml(user, cls = '') {
  const initial = esc((user && (user.name || user.screenName) || '?').slice(0, 1));
  if (user && user.avatar) {
    return `<img class="avatar ${cls}" loading="lazy" src="${esc(user.avatar)}" alt="" referrerpolicy="no-referrer" />`;
  }
  return `<div class="avatar avatar-fallback ${cls}">${initial}</div>`;
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

async function loadData() {
  const all = await new Promise((r) => chrome.storage.local.get(null, r));
  state.accounts = all.lanAccounts || [];
  const activeId = all.lanActive;
  state.account = state.accounts.find((a) => a.id === activeId) || state.accounts[0] || null;
  state.task = all.lanTask || null;
  const storedSettings = all.lanSettings || {};
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    // 时间间隔固定，导入旧备份或旧版本设置也不会生效
    ...FIXED_INTERVALS,
    limitDefault:
      Number(storedSettings.limitDefault) > 0
        ? Number(storedSettings.limitDefault)
        : DEFAULT_SETTINGS.limitDefault,
  };
  state.captures = all.lanCaptures || null;

  if (state.account) {
    state.relations = all[`lanRelations:${state.account.id}`] || {};
    state.protectedMap = all[`lanProtected:${state.account.id}`] || {};
    state.history = all[`lanHistory:${state.account.id}`] || [];
    state.scan = all[`lanScan:${state.account.id}`] || null;
  } else {
    state.relations = {};
    state.protectedMap = {};
    state.history = [];
    state.scan = null;
  }

  // 清理已经不存在的选择
  const valid = new Set(Object.keys(state.relations));
  for (const id of Array.from(state.selected)) {
    if (!valid.has(id) || !isCurrentRelation(state.relations[id])) state.selected.delete(id);
  }

  renderAll();
}

function isCurrentRelation(rel) {
  if (!rel) return false;
  if (!state.scan) return true;
  if (rel.scanId && rel.scanId === state.scan.taskId) return true;
  return isProtected(rel);
}

function getStats() {
  const values = Object.values(state.relations).filter(isCurrentRelation);
  const stats = {
    mutual: values.filter((r) => r.following && r.followsMe).length,
    notFollowingBack: values.filter((r) => r.following && !r.followsMe).length,
    notFollowedByMe: values.filter((r) => r.followsMe && !r.following).length,
    total: values.length,
    protected: Object.keys(state.protectedMap).length,
  };
  if (state.scan && state.scan.followersUnavailable) stats.notFollowedByMe = null;
  return stats;
}

function isProtected(rel) {
  if (!rel) return false;
  if (state.protectedMap[rel.id]) return true;
  if (rel.screenName && state.protectedMap[`sn:${rel.screenName.toLowerCase()}`]) return true;
  return false;
}

function hasTemplates() {
  const caps = state.captures;
  if (!caps || !caps.operations) return false;
  return (
    !!caps.operations.Following &&
    !!caps.operations.Following.queryId &&
    !!caps.operations.Followers &&
    !!caps.operations.Followers.queryId
  );
}

/* ------------------------------------------------------------------ */
/* 渲染总入口                                                          */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderShell();
  renderOverview();
  renderRelations();
  renderProtect();
  renderSettings();
  renderBackup();
  renderTaskPanel();
  renderBanner();
  renderSelectionBar();
}

function renderShell() {
  // 侧边导航
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));

  const titles = PAGE_TITLES[state.route] || PAGE_TITLES.overview;
  $('#pageTitle').textContent = titles[0];
  $('#pageSub').textContent = titles[1];

  $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === state.route));

  // 侧边账号
  const side = $('#sideAccount');
  if (state.account) {
    side.innerHTML = `
      <div class="side-acc-inner">
        ${avatarHtml(state.account)}
        <div style="min-width:0">
          <div class="side-acc-name">${esc(state.account.name || state.account.screenName)}</div>
          <div class="side-acc-handle">@${esc(state.account.screenName)}</div>
        </div>
      </div>
      <button class="btn ghost" id="sideConnect">重新连接</button>`;
  } else {
    side.innerHTML = `
      <div class="side-acc-name">尚未连接</div>
      <div class="side-acc-handle">连接当前浏览器登录的 X</div>
      <button class="btn soft" id="sideConnect">连接 X 账号</button>`;
  }
  const sideBtn = $('#sideConnect');
  if (sideBtn) sideBtn.addEventListener('click', connect);

  // 顶部
  $('#topDetect').textContent = state.task && state.task.status === 'running' ? '检测进行中' : '开始检测';
  $('#topDetect').disabled = !state.account || (state.task && state.task.status === 'running');

  const resumable =
    state.task &&
    ['interrupted', 'stopped', 'error'].includes(state.task.status);
  $('#resumeBtn').classList.toggle('hidden', !resumable);
  if (resumable) {
    $('#resumeBtn').textContent =
      state.task.type === 'detect' ? '继续检测' : '继续取关';
  }

  // 统计
  const stats = getStats();
  $$('[data-stat]').forEach((el) => {
    const key = el.dataset.stat;
    if (key in stats) el.textContent = stats[key] == null ? '—' : fmtNum(stats[key]);
  });

  // 接口状态
  const templateState = $('#templateState');
  if (templateState) {
    if (hasTemplates()) {
      templateState.textContent = `接口参数：已缓存 · ${fmtTime(state.captures.updatedAt)}`;
    } else {
      templateState.textContent = '接口参数：未缓存，首次检测时自动获取';
    }
  }
}

function renderBanner() {
  const banner = $('#banner');
  if (!state.account) {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span>先连接 X 账号，才能读取你的关注与粉丝名单。</span>
      <button class="btn soft sm" id="bannerConnect">连接 X</button>`;
    $('#bannerConnect').addEventListener('click', connect);
  } else {
    banner.classList.add('hidden');
    banner.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ */
/* 概览                                                                */
/* ------------------------------------------------------------------ */

function renderOverview() {
  const box = $('#accountCard');
  if (!state.account) {
    box.innerHTML = `
      <div class="acc-empty">
        <span class="eyebrow">ACCOUNT</span>
        <h2>还没有连接 X</h2>
        <p>使用当前浏览器已登录的账号。检测只读取关系，数据只保存在这台电脑。</p>
        <button class="btn primary" id="accConnect" style="align-self:flex-start">连接 X 账号</button>
      </div>`;
    $('#accConnect').addEventListener('click', connect);
  } else {
    const stats = getStats();
    box.innerHTML = `
      <div class="acc-hero">
        ${avatarHtml(state.account)}
        <div style="min-width:0">
          <div class="acc-name">${esc(state.account.name || state.account.screenName)}</div>
          <div class="acc-handle">@${esc(state.account.screenName)}</div>
          <div class="acc-badges">
            <span class="chip mint"><span class="dot"></span>已连接</span>
            ${
              state.account.lastDetectAt
                ? `<span class="chip">上次检测 ${fmtTime(state.account.lastDetectAt)}</span>`
                : `<span class="chip amber">尚未检测</span>`
            }
          </div>
        </div>
      </div>
      <div class="acc-foot">
        <span>${
          state.scan
            ? `本次检测 ${fmtNum(state.scan.scannedFollowing)} 关注 · ${
                state.scan.followersUnavailable
                  ? '粉丝未获取'
                  : `${fmtNum(state.scan.scannedFollowers)} 粉丝${state.scan.followersPartial ? '（部分）' : ''}`
              }${state.scan.limit ? `（上限 ${fmtNum(state.scan.limit)}）` : ''}`
            : `本机记录 ${fmtNum(stats.total)} 人`
        } · 特别关注 ${fmtNum(stats.protected)} 人</span>
        <button class="btn link" id="accConnect">重新连接</button>
      </div>`;
    $('#accConnect').addEventListener('click', connect);
  }

  // 最近记录
  const list = $('#historyList');
  if (!state.history.length) {
    list.innerHTML = `<div class="empty-mini">还没有记录。完成一次检测后，这里会显示历史。</div>`;
  } else {
    list.innerHTML = state.history
      .slice(0, 6)
      .map((h) => {
        const isDetect = h.type === 'detect';
        const title = isDetect
          ? `检测完成 · 未回关 ${fmtNum(h.stats && h.stats.notFollowingBack)} 人`
          : `批量取关 · 成功 ${fmtNum(h.result && h.result.ok)} 人`;
        const meta = isDetect
          ? `互关 ${fmtNum(h.stats && h.stats.mutual)} · 我未回关 ${
              h.stats && h.stats.notFollowedByMe == null ? '—' : fmtNum(h.stats && h.stats.notFollowedByMe)
            }`
          : `失败 ${fmtNum(h.result && h.result.failed)} · 跳过 ${fmtNum(h.result && h.result.protected)}`;
        return `
          <div class="history-item">
            <div class="history-main">
              <div class="history-icon ${isDetect ? '' : 'unfollow'}">${isDetect ? '◎' : '↯'}</div>
              <div>
                <div class="history-title">${title}</div>
                <div class="history-meta">${meta}</div>
              </div>
            </div>
            <span class="history-time">${fmtTime(h.at)}</span>
          </div>`;
      })
      .join('');
  }
}

/* ------------------------------------------------------------------ */
/* 任务面板                                                            */
/* ------------------------------------------------------------------ */

function renderTaskPanel() {
  const panel = $('#taskPanel');
  const task = state.task;
  const visible =
    task &&
    !task.dismissed &&
    (['running', 'interrupted', 'stopped', 'error'].includes(task.status) ||
      (task.status === 'done' && Date.now() - (task.endedAt || 0) < 10 * 60 * 1000));

  panel.classList.toggle('hidden', !visible);
  if (!visible) return;

  panel.classList.toggle('is-error', task.status === 'error' || task.status === 'interrupted');
  panel.classList.toggle('is-done', task.status === 'done');

  $('#taskType').textContent = task.type === 'detect' ? '检测' : '取关';
  const progress = task.progress || {};
  $('#taskPhase').textContent = progress.phase || (task.status === 'running' ? '进行中' : '任务');
  $('#taskMessage').textContent = progress.message || '';
  $('#taskTime').textContent = task.endedAt
    ? `结束于 ${fmtTime(task.endedAt)}`
    : `开始于 ${fmtTime(task.startedAt)}`;

  const done = progress.done || 0;
  const total = progress.total || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : task.status === 'running' ? 24 : 100;
  $('#taskBar').style.width = pct + '%';
  $('#taskCount').textContent = total ? `${fmtNum(done)} / ${fmtNum(total)}` : '';

  const err = $('#taskError');
  if (task.status === 'error' && task.error) {
    err.classList.remove('hidden');
    err.textContent = task.error;
  } else {
    err.classList.add('hidden');
    err.textContent = '';
  }

  const stopBtn = $('#taskStop');
  const resumeBtn = $('#taskResume');
  const dismissBtn = $('#taskDismiss');

  stopBtn.classList.toggle('hidden', task.status !== 'running');
  const canResume =
    ['interrupted', 'stopped', 'error'].includes(task.status) &&
    (task.type === 'detect'
      ? true
      : task.state && task.state.index < (task.state.items || []).length);
  resumeBtn.classList.toggle('hidden', !canResume);
  dismissBtn.classList.toggle('hidden', task.status === 'running');
}

function renderRelations() {
  if (state.route !== 'relations') return;

  $$('#filterTabs button').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));

  const q = state.search.trim().toLowerCase();
  const all = Object.values(state.relations);

  const filtered = all.filter((r) => {
    if (!isCurrentRelation(r)) return false;
    if (state.filter === 'notFollowingBack' && !(r.following && !r.followsMe)) return false;
    if (state.filter === 'notFollowedByMe' && !(r.followsMe && !r.following)) return false;
    if (state.filter === 'mutual' && !(r.following && r.followsMe)) return false;
    if (state.filter === 'protected' && !isProtected(r)) return false;
    if (state.filter === 'all' && !(r.following || r.followsMe || r.scannedAt)) return false;
    if (q) {
      const hay = `${r.name || ''} ${r.screenName || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (!!b.protected !== !!a.protected) return b.protected ? 1 : -1;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  const pageSize = state.pageSize;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  $('#listCount').textContent = `共 ${fmtNum(filtered.length)} 人${
    state.scan ? ` · 最近检测 ${fmtTime(state.scan.at)}` : ''
  }${state.scan && state.scan.followersUnavailable ? ' · 粉丝名单未获取' : ''}${
    state.scan && state.scan.followersPartial ? ' · 粉丝名单不完整' : ''
  }`;
  const selectable = pageItems.filter((r) => r.following && !isProtected(r));
  const selectedCount = state.selected.size;
  $('#selectHint').innerHTML = `
    <span>${selectedCount ? `已选择 ${selectedCount} 人` : '勾选名字可批量取关'}</span>
    ${
      selectable.length
        ? ` · <button class="btn link" id="selectPage" style="font-size:12px">全选本页</button>`
        : ''
    }
    ${selectedCount ? ` · <button class="btn link" id="clearPage" style="font-size:12px">清空选择</button>` : ''}`;

  const list = $('#relationList');
  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-ico">◎</div>
        <h4>这里还没有人</h4>
        <p>${
          state.filter === 'notFollowedByMe' && state.scan && state.scan.followersUnavailable
            ? '本次检测未能获取粉丝名单，无法统计「我未回关」。可以换个筛选条件，或在粉丝接口恢复后重新检测。'
            : Object.keys(state.relations).length
            ? '换个筛选条件试试，或调整搜索关键词。'
            : '先完成一次检测，关系名单会出现在这里。'
        }</p>
      </div>`;
    $('#pager').innerHTML = '';
    bindListMeta();
    renderSelectionBar();
    return;
  }

  list.innerHTML = pageItems
    .map((r) => {
      const protectedUser = isProtected(r);
      const selectableUser = r.following && !protectedUser;
      const selected = state.selected.has(r.id);
      const badges = [];
      if (r.following && r.followsMe) badges.push('<span class="chip mint">互关</span>');
      if (r.following && !r.followsMe) badges.push('<span class="chip rose">未回关</span>');
      if (!r.following && r.followsMe) badges.push('<span class="chip blue">我未回关</span>');
      if (protectedUser) badges.push('<span class="chip amber">特别关注</span>');
      if (r.unfollowedAt) badges.push('<span class="chip">已取关</span>');

      return `
        <div class="rel-row ${selected ? 'selected' : ''}" data-id="${esc(r.id)}">
          <button class="rel-check ${selected ? 'on' : ''} ${selectableUser ? '' : 'disabled'}"
                  data-act="select" title="${protectedUser ? '特别关注不会被批量清理' : selectableUser ? '选择' : '当前未关注该账号'}">
            ${selected ? '✓' : ''}
          </button>
          ${avatarHtml(r)}
          <div class="rel-main">
            <div class="rel-name">${esc(r.name || r.screenName)}</div>
            <div class="rel-handle">@${esc(r.screenName)}</div>
          </div>
          <div class="rel-badges">${badges.join('')}</div>
          <div class="rel-actions">
            <button class="icon-btn ${protectedUser ? 'protected' : ''}" data-act="protect"
                    title="${protectedUser ? '移出特别关注' : '加入特别关注'}">${protectedUser ? '★' : '☆'}</button>
            <button class="icon-btn" data-act="open" title="打开主页">↗</button>
          </div>
        </div>`;
    })
    .join('');

  renderPager(pages);
  bindListMeta();
  renderSelectionBar();
}

function renderPager(pages) {
  const pager = $('#pager');
  if (pages <= 1) {
    pager.innerHTML = '';
    return;
  }
  const current = state.page;
  const buttons = [];
  buttons.push(`<button data-page="${current - 1}" ${current === 1 ? 'disabled' : ''}>上一页</button>`);

  const nums = new Set([1, pages, current, current - 1, current + 1]);
  const sorted = Array.from(nums).filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) buttons.push('<button disabled>…</button>');
    buttons.push(`<button data-page="${n}" class="${n === current ? 'active' : ''}">${n}</button>`);
    prev = n;
  }
  buttons.push(`<button data-page="${current + 1}" ${current === pages ? 'disabled' : ''}>下一页</button>`);
  pager.innerHTML = buttons.join('');
}

function bindListMeta() {
  const sp = $('#selectPage');
  if (sp) {
    sp.addEventListener('click', () => {
      const visible = currentPageItems();
      for (const r of visible) if (r.following && !isProtected(r)) state.selected.add(r.id);
      renderRelations();
    });
  }
  const cp = $('#clearPage');
  if (cp) {
    cp.addEventListener('click', () => {
      state.selected.clear();
      renderRelations();
    });
  }
}

function filteredItems() {
  const q = state.search.trim().toLowerCase();
  return Object.values(state.relations)
    .filter((r) => {
      if (!isCurrentRelation(r)) return false;
      if (state.filter === 'notFollowingBack' && !(r.following && !r.followsMe)) return false;
      if (state.filter === 'notFollowedByMe' && !(r.followsMe && !r.following)) return false;
      if (state.filter === 'mutual' && !(r.following && r.followsMe)) return false;
      if (state.filter === 'protected' && !isProtected(r)) return false;
      if (state.filter === 'all' && !(r.following || r.followsMe || r.scannedAt)) return false;
      if (q) {
        const hay = `${r.name || ''} ${r.screenName || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (!!b.protected !== !!a.protected) return b.protected ? 1 : -1;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
}

function currentPageItems() {
  const items = filteredItems();
  const start = (state.page - 1) * state.pageSize;
  return items.slice(start, start + state.pageSize);
}

function renderSelectionBar() {
  const bar = $('#selectBar');
  const count = state.selected.size;
  bar.classList.toggle('hidden', state.route !== 'relations' || count === 0);
  if (!count) return;
  $('#selectedCount').textContent = count;
  const items = Array.from(state.selected)
    .map((id) => state.relations[id])
    .filter((r) => r && r.following && !isProtected(r));
  $('#selectNote').textContent =
    items.length === count ? '特别关注会自动跳过' : `其中 ${count - items.length} 人不可取关`;

  const running = state.task && state.task.status === 'running';
  $('#unfollowSelected').disabled = running || items.length === 0;
  $('#unfollowSelected').textContent = running ? '任务进行中' : `批量取关 ${items.length} 人`;
}

/* ------------------------------------------------------------------ */
/* 特别关注                                                            */
/* ------------------------------------------------------------------ */

function renderProtect() {
  if (state.route !== 'protect') return;
  const keys = Object.keys(state.protectedMap);
  $('#protectCount').textContent = `${keys.length} 人`;

  const byHandle = new Map();
  for (const r of Object.values(state.relations)) {
    if (r.screenName) byHandle.set(r.screenName.toLowerCase(), r);
  }

  const list = $('#protectList');
  if (!keys.length) {
    list.innerHTML = `<div class="empty-mini">还没有特别关注。想留下的人先加进来，批量清理时会自动保留。</div>`;
    return;
  }

  const rows = keys.map((key) => {
    const item = state.protectedMap[key];
    const handle = (item.screenName || '').toLowerCase();
    const rel = item.id ? state.relations[item.id] : byHandle.get(handle);
    const user = rel || { screenName: item.screenName, name: item.name || item.screenName, avatar: null };
    return `
      <div class="protect-row" data-key="${esc(key)}">
        ${avatarHtml(user)}
        <div class="protect-main">
          <div class="protect-name">${esc(user.name || user.screenName || '未知')}</div>
          <div class="protect-handle">@${esc(user.screenName || item.screenName || '—')}</div>
        </div>
        <span class="chip amber">保护中</span>
        <button class="btn ghost xs" data-act="unprotect">移出</button>
      </div>`;
  });
  list.innerHTML = rows.join('');

  list.querySelectorAll('[data-act="unprotect"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.protect-row');
      const key = row.dataset.key;
      const item = state.protectedMap[key];
      if (!item) return;
      delete state.protectedMap[key];
      // 同时清理 id / handle 两种键
      if (item.screenName) {
        const snKey = `sn:${item.screenName.toLowerCase()}`;
        if (state.protectedMap[snKey]) delete state.protectedMap[snKey];
      }
      for (const [k, v] of Object.entries(state.protectedMap)) {
        if (v && item.screenName && v.screenName === item.screenName) delete state.protectedMap[k];
      }
      if (item.id && state.relations[item.id]) state.relations[item.id].protected = false;
      await saveProtected();
      toast('已移出特别关注');
      renderAll();
    });
  });
}

async function saveProtected() {
  if (!state.account) return;
  await chrome.storage.local.set({ [`lanProtected:${state.account.id}`]: state.protectedMap });
}

async function addProtection(raw) {
  const handle = parseHandle(raw);
  if (!handle) {
    toast('请输入 @handle 或 x.com 主页链接', true);
    return;
  }
  if (!state.account) {
    toast('请先连接 X 账号', true);
    return;
  }
  const lower = handle.toLowerCase();
  if (state.protectedMap[`sn:${lower}`]) {
    toast('已经在特别关注里了');
    return;
  }
  const rel = Object.values(state.relations).find(
    (r) => r.screenName && r.screenName.toLowerCase() === lower
  );
  if (rel && state.protectedMap[rel.id]) {
    toast('已经在特别关注里了');
    return;
  }

  const key = rel ? rel.id : `sn:${lower}`;
  state.protectedMap[key] = {
    id: rel ? rel.id : undefined,
    screenName: rel ? rel.screenName : handle,
    name: rel ? rel.name : handle,
    addedAt: Date.now(),
    manual: !rel,
  };
  if (rel) state.relations[rel.id].protected = true;
  await saveProtected();
  toast(`已加入特别关注 @${handle}`);
  renderAll();
}

async function toggleProtect(rel) {
  const on = isProtected(rel);
  if (on) {
    delete state.protectedMap[rel.id];
    if (state.protectedMap[`sn:${(rel.screenName || '').toLowerCase()}`]) {
      delete state.protectedMap[`sn:${(rel.screenName || '').toLowerCase()}`];
    }
  } else {
    state.protectedMap[rel.id] = {
      id: rel.id,
      screenName: rel.screenName,
      name: rel.name,
      addedAt: Date.now(),
    };
  }
  if (state.relations[rel.id]) state.relations[rel.id].protected = !on;
  if (on) state.selected.delete(rel.id);
  await saveProtected();
  toast(on ? `已移出特别关注 @${rel.screenName}` : `已保护 @${rel.screenName}`);
  renderAll();
}

/* ------------------------------------------------------------------ */
/* 备份与设置                                                          */
/* ------------------------------------------------------------------ */

function renderBackup() {
  if (state.route !== 'backup') return;
  const relationsCount = Object.keys(state.relations).length;
  const protectCount = Object.keys(state.protectedMap).length;

  chrome.storage.local.getBytesInUse(null, (bytes) => {
    const kb = (bytes / 1024).toFixed(1);
    $('#storageInfo').innerHTML = `
      <div class="row"><span>占用空间</span><b>${kb} KB</b></div>
      <div class="row"><span>关系记录</span><b>${fmtNum(relationsCount)} 条</b></div>
      <div class="row"><span>特别关注</span><b>${fmtNum(protectCount)} 人</b></div>
      <div class="row"><span>历史任务</span><b>${fmtNum(state.history.length)} 条</b></div>
      <div class="row"><span>账号</span><b>${fmtNum(state.accounts.length)} 个</b></div>`;
  });
}

function renderSettings() {
  if (state.route !== 'settings') return;
  const form = $('#settingsForm');
  for (const [key, value] of Object.entries(state.settings)) {
    const input = form.elements[key];
    if (input) input.value = value;
  }

  $('#aboutVersion').textContent = 'v' + (chrome.runtime.getManifest().version || '0.1.0');

  const capState = $('#capState');
  const capTime = $('#capTime');
  if (hasTemplates()) {
    capState.textContent = '已缓存';
    capTime.textContent = fmtDate(state.captures.updatedAt);
  } else {
    capState.textContent = '未缓存';
    capTime.textContent = state.captures ? fmtDate(state.captures.updatedAt) : '—';
  }
}

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

function openModal(html) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  return root;
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
}

function openDetectModal() {
  if (!state.account) {
    toast('请先连接 X 账号', true);
    return;
  }
  if (state.task && state.task.status === 'running') {
    toast('已有任务在运行');
    return;
  }
  const def = state.settings.limitDefault || 1000;
  const root = openModal(`
    <h3>开始检测</h3>
    <p class="modal-sub">只读取关注与粉丝关系，不会自动取关。检测过程中可以继续浏览其他页面，但请保留后台执行页。</p>
    <div class="option-list">
      <label class="option">
        <input type="radio" name="limit" value="${def}" checked />
        <div><b>先测 ${fmtNum(def)} 人</b><span>推荐。名单较大时可先看一部分。</span></div>
      </label>
      <label class="option">
        <input type="radio" name="limit" value="3000" />
        <div><b>3,000 人</b><span>更完整，耗时更长。</span></div>
      </label>
      <label class="option">
        <input type="radio" name="limit" value="0" />
        <div><b>全部</b><span>读取所有正在关注与关注我的人，可能较慢。</span></div>
      </label>
    </div>
    <p class="hint">首次检测会短暂打开一次你的「正在关注 / 关注我的人」页面，用于获取 X 网页端的接口参数。</p>
    <div class="modal-actions">
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn primary" data-act="start">开始检测</button>
    </div>`);

  root.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
  root.querySelector('[data-act="start"]').addEventListener('click', async (e) => {
    const limit = Number(root.querySelector('input[name="limit"]:checked').value) || 0;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '正在启动…';
    const res = await send('lan:start-detect', { options: { limit } });
    if (!res.ok) {
      toast(res.error || '启动失败', true);
      btn.disabled = false;
      btn.textContent = '开始检测';
      return;
    }
    closeModal();
    toast('检测已开始');
    loadData();
  });
}

function openUnfollowModal() {
  if (!state.account) return;
  if (state.task && state.task.status === 'running') {
    toast('已有任务在运行，请先等待或停止');
    return;
  }
  const items = Array.from(state.selected)
    .map((id) => state.relations[id])
    .filter((r) => r && r.following && !isProtected(r));

  if (!items.length) {
    toast('没有可清理的账号', true);
    return;
  }

  const names = items
    .slice(0, 8)
    .map((r) => `@${esc(r.screenName)}`)
    .join('、');
  const more = items.length > 8 ? ` 等 ${items.length} 人` : '';

  const root = openModal(`
    <h3>确认批量取关</h3>
    <p class="modal-sub">将对 <b>${fmtNum(items.length)}</b> 个未回关账号执行取关。特别关注和已加入保护的人不会被执行。</p>
    <div class="confirm-list">${names}${more}</div>
    <p class="hint">取关会在 ${(state.settings.unfollowMinDelayMs / 1000).toFixed(1)}–${(
      state.settings.unfollowMaxDelayMs / 1000
    ).toFixed(1)} 秒的随机间隔下逐个执行，可随时停止。此操作不可撤销。</p>
    <div class="modal-actions">
      <button class="btn ghost" data-act="cancel">再想想</button>
      <button class="btn danger" data-act="confirm">确认取关</button>
    </div>`);

  root.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
  root.querySelector('[data-act="confirm"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '正在启动…';
    const payload = {
      items: items.map((r) => ({
        id: r.id,
        screenName: r.screenName,
        name: r.name,
        avatar: r.avatar,
      })),
    };
    const res = await send('lan:start-unfollow', { payload });
    if (!res.ok) {
      toast(res.error || '启动失败', true);
      btn.disabled = false;
      btn.textContent = '确认取关';
      return;
    }
    closeModal();
    state.selected.clear();
    toast(`已开始批量取关 ${items.length} 人`);
    loadData();
  });
}

function openClearModal() {
  const root = openModal(`
    <h3>清空所有本机数据？</h3>
    <p class="modal-sub">将删除账号连接、关系记录、特别关注、任务记录与接口缓存。此操作无法撤销。</p>
    <p class="hint">建议先在「备份与恢复」中导出 JSON 备份。</p>
    <div class="modal-actions">
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn danger" data-act="confirm">确认清空</button>
    </div>`);
  root.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
  root.querySelector('[data-act="confirm"]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const settings = state.settings;
    await new Promise((r) => chrome.storage.local.clear(r));
    await chrome.storage.local.set({
      lanSettings: settings,
      lanAccounts: [],
      lanTask: null,
      lanWorkerTab: null,
    });
    closeModal();
    toast('已清空本机数据');
    state.selected.clear();
    loadData();
  });
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

async function connect() {
  if (state.busy) return;
  state.busy = true;
  toast('正在连接 X…');
  const res = await send('lan:connect');
  state.busy = false;
  if (!res.ok) {
    toast(res.error || '连接失败', true);
    return;
  }
  toast('已连接 @' + res.account.screenName);
  await loadData();
}

async function startDetection() {
  openDetectModal();
}

async function resumeTask() {
  if (!state.task) return;
  if (state.task.type === 'detect') {
    const res = await send('lan:start-detect', { options: { resume: true } });
    if (!res.ok) return toast(res.error || '继续失败', true);
  } else {
    const res = await send('lan:start-unfollow', { payload: { resume: true, items: [] } });
    if (!res.ok) return toast(res.error || '继续失败', true);
  }
  toast('已继续上次任务');
  loadData();
}

async function cancelTask() {
  const res = await send('lan:cancel');
  if (!res.ok) return toast(res.error || '停止失败', true);
  toast('正在停止…');
}

async function dismissTask() {
  if (!state.task) return;
  state.task.dismissed = true;
  await chrome.storage.local.set({ lanTask: state.task });
  loadData();
}

async function refreshTemplates() {
  const res = await send('lan:ensure-templates', { force: true });
  if (!res.ok) return toast(res.error || '刷新失败', true);
  toast('正在后台获取接口参数，稍等片刻');
  setTimeout(loadData, 8000);
}

function renderSelfTest(report) {
  const icons = { ok: '✓', error: '!', warn: '!', pending: '…', info: 'i' };
  const start = report.startedAt || Date.now();
  const rows = (report.steps || [])
    .map((s) => {
      const seconds = s.at ? ((s.at - start) / 1000).toFixed(1) + 's' : '';
      return `<div class="selftest-row ${esc(s.status)}">
        <span class="st-dot">${icons[s.status] || '·'}</span>
        <div style="min-width:0">
          <b>${esc(s.name)}</b>
          <span class="st-detail">${esc(s.detail)}</span>
        </div>
        ${seconds ? `<span class="st-time">${seconds}</span>` : ''}
      </div>`;
    })
    .join('');
  const stepsList = report.steps || [];
  const hasError = stepsList.some((s) => s.status === 'error');
  const followersWarn = stepsList.some((s) => s.name === '读取粉丝第一页' && s.status !== 'ok');
  const writeWarn = stepsList.some((s) => s.name === '写接口探测' && s.status !== 'ok');
  let summary;
  if (report.ok) {
    summary = '✓ 自检通过：真实环境下的检测链路可用。可以回到「关系名单」开始正式检测。';
  } else if (!hasError && followersWarn && writeWarn) {
    summary =
      '主检测可用：能统计「未回关我」。本次粉丝名单未获取，「我未回关」不可用；写接口也未确认，正式取关前请先用小号验证。';
  } else if (!hasError && followersWarn) {
    summary =
      '主检测可用：可以准确统计「未回关我」。本次粉丝名单未获取，「我未回关」暂不可用。';
  } else if (!hasError && writeWarn) {
    summary =
      '读取链路可用，但写接口未确认（X 可能变更了取关接口）。正式取关前，请先在一个不需要保留的小号上试一次。';
  } else {
    summary =
      '部分检查未通过。可以先点上方「刷新接口参数」再试；如果仍然失败，请复制结果发给开发者。';
  }
  $('#selfTestResult').innerHTML =
    rows + `<div class="selftest-summary ${report.ok ? '' : 'bad'}">${summary}</div>`;
  $('#copySelfTest').classList.remove('hidden');
}

async function runSelfTest() {
  const btn = $('#selfTestBtn');
  const chip = $('#selfTestStatus');
  btn.disabled = true;
  btn.textContent = '自检中…（最多约 1 分钟）';
  chip.textContent = '运行中';
  chip.className = 'chip blue';
  $('#copySelfTest').classList.add('hidden');
  $('#selfTestResult').innerHTML = `
    <div class="selftest-row pending">
      <span class="st-dot">…</span>
      <div><b>正在检查</b><span class="st-detail">读取当前登录账号与 X 接口参数，只读，不会修改名单…</span></div>
    </div>`;

  const res = await send('lan:selftest');
  btn.disabled = false;
  btn.textContent = '重新自检';

  if (!res.ok || !res.report) {
    chip.textContent = '失败';
    chip.className = 'chip rose';
    $('#selfTestResult').innerHTML = `
      <div class="selftest-row error">
        <span class="st-dot">!</span>
        <div><b>自检启动失败</b><span class="st-detail">${esc(res.error || '没有返回结果')}</span></div>
      </div>`;
    return;
  }

  state.selfTestReport = {
    ...res.report,
    meta: {
      version: chrome.runtime.getManifest().version,
      browser: navigator.userAgent,
      at: new Date().toISOString(),
    },
  };
  renderSelfTest(res.report);
  chip.textContent = res.report.ok ? '通过' : '有问题';
  chip.className = 'chip ' + (res.report.ok ? 'mint' : 'rose');
}

async function toggleFilter(filter) {
  if (filter === 'protected') {
    navigateTo('protect');
    return;
  }
  state.filter = filter;
  state.page = 1;
  if (state.route !== 'relations') {
    location.hash = `#/relations?filter=${filter}`;
  } else {
    renderRelations();
    renderSelectionBar();
  }
}

function navigateTo(route) {
  location.hash = '#/' + route;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const hash = location.hash || '#/overview';
  const [, routePart, queryPart] = hash.match(/^#\/([a-z]+)(?:\?(.*))?$/) || [];
  const route = PAGE_TITLES[routePart] ? routePart : 'overview';
  const params = new URLSearchParams(queryPart || '');
  return { route, params };
}

function handleRoute() {
  const { route, params } = parseRoute();
  state.route = route;
  if (params.get('filter') && FILTERS[params.get('filter')]) {
    state.filter = params.get('filter');
    state.page = 1;
  }
  renderShell();
  renderRelations();
  renderProtect();
  renderBackup();
  renderSettings();
  renderSelectionBar();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  window.addEventListener('hashchange', handleRoute);

  $('#topDetect').addEventListener('click', startDetection);
  $('#detectBtn').addEventListener('click', startDetection);
  $('#refreshTemplatesBtn').addEventListener('click', refreshTemplates);
  $('#resumeBtn').addEventListener('click', resumeTask);

  $('#taskStop').addEventListener('click', cancelTask);
  $('#taskResume').addEventListener('click', resumeTask);
  $('#taskDismiss').addEventListener('click', dismissTask);

  $$('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => {
      const filter = el.dataset.goto;
      if (filter === 'protected') navigateTo('protect');
      else location.hash = `#/relations?filter=${filter}`;
    });
  });

  $('#filterTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    state.page = 1;
    renderRelations();
    renderSelectionBar();
    history.replaceState(null, '', `#/relations?filter=${state.filter}`);
  });

  $('#searchInput').addEventListener('input', debounce((e) => {
    state.search = e.target.value;
    state.page = 1;
    renderRelations();
    renderSelectionBar();
  }, 180));

  $('#pageSize').addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value) || 50;
    state.page = 1;
    renderRelations();
  });

  $('#pager').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    state.page = Number(btn.dataset.page);
    renderRelations();
    renderSelectionBar();
  });

  $('#relationList').addEventListener('click', async (e) => {
    const row = e.target.closest('.rel-row');
    if (!row) return;
    const id = row.dataset.id;
    const rel = state.relations[id];
    if (!rel) return;
    const act = e.target.closest('[data-act]');
    const action = act ? act.dataset.act : null;

    if (action === 'open') {
      if (rel.screenName) {
        chrome.tabs.create({ url: 'https://x.com/' + encodeURIComponent(rel.screenName) });
      }
      return;
    }
    if (action === 'protect') {
      await toggleProtect(rel);
      return;
    }
    if (action === 'select' || !action) {
      if (!rel.following || isProtected(rel)) {
        if (isProtected(rel)) toast('特别关注不会被批量清理');
        return;
      }
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      renderRelations();
      renderSelectionBar();
    }
  });

  $('#clearSelection').addEventListener('click', () => {
    state.selected.clear();
    renderRelations();
    renderSelectionBar();
  });

  $('#unfollowSelected').addEventListener('click', openUnfollowModal);

  $('#protectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await addProtection($('#protectInput').value);
    $('#protectInput').value = '';
  });

  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const limit = Number(form.elements.limitDefault.value);
    if (!Number.isFinite(limit) || limit < 100) {
      toast('请输入有效的检测人数（至少 100）', true);
      return;
    }
    // 时间间隔固定，只允许保存默认检测人数
    const next = { ...state.settings, ...FIXED_INTERVALS, limitDefault: limit };
    await chrome.storage.local.set({ lanSettings: next });
    state.settings = next;
    toast('默认检测人数已保存');
  });

  $('#settingsRefreshCaps').addEventListener('click', refreshTemplates);
  $('#selfTestBtn').addEventListener('click', runSelfTest);
  $('#copySelfTest').addEventListener('click', async () => {
    if (!state.selfTestReport) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.selfTestReport, null, 2));
      toast('自检结果已复制，可以粘贴发给开发者');
    } catch (_) {
      toast('复制失败，请手动选择结果', true);
    }
  });
  $('#clearCaps').addEventListener('click', async () => {
    await chrome.storage.local.remove('lanCaptures');
    toast('接口缓存已清除');
    loadData();
  });

  $('#exportBtn').addEventListener('click', async () => {
    const all = await new Promise((r) => chrome.storage.local.get(null, r));
    // 不导出与具体标签页绑定的临时状态、当前任务，以及含会话请求头的接口缓存
    delete all.lanWorkerTab;
    delete all.lanWarmups;
    delete all.lanTask;
    delete all.lanCaptures;
    const payload = {
      app: 'lan-blue',
      schema: 1,
      exportedAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      data: all,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    a.href = url;
    a.download = `关注整理所-备份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('备份已导出');
  });

  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (!payload || payload.app !== 'lan-blue' || !payload.data) {
        throw new Error('不是关注整理所的备份文件');
      }
      const count = Object.keys(payload.data).filter((k) => k.startsWith('lan')).length;
      const root = openModal(`
        <h3>导入备份？</h3>
        <p class="modal-sub">备份包含 ${count} 项数据，导入后会覆盖同名的本机数据。现有记录不会自动合并。</p>
        <div class="modal-actions">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="confirm">确认导入</button>
        </div>`);
      root.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
      root.querySelector('[data-act="confirm"]').addEventListener('click', async (ev) => {
        ev.currentTarget.disabled = true;
        const clean = {};
        for (const [k, v] of Object.entries(payload.data)) {
          if (!k.startsWith('lan')) continue;
          if (k === 'lanWorkerTab' || k === 'lanWarmups' || k === 'lanTask' || k === 'lanCaptures') continue;
          clean[k] = v;
        }
        await chrome.storage.local.set(clean);
        closeModal();
        toast('备份已导入');
        state.selected.clear();
        loadData();
      });
    } catch (err) {
      toast(err.message || '备份文件无法读取', true);
    }
  });

  $('#clearBtn').addEventListener('click', openClearModal);

  // 账号点击、统计卡
  $$('.stat-card').forEach((card) => {
    card.addEventListener('click', () => {
      const filter = card.dataset.goto;
      if (filter === 'protected') navigateTo('protect');
      else location.hash = `#/relations?filter=${filter}`;
    });
  });

  // 数据变更（后台任务写入时）自动刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes);
    if (!keys.some((k) => k.startsWith('lan'))) return;

    // 仅任务进度变化时做轻量刷新，避免整页重绘
    if (keys.length === 1 && keys[0] === 'lanTask' && state.route !== 'relations') {
      state.task = changes.lanTask.newValue || null;
      renderTaskPanel();
      renderShell();
      return;
    }
    debouncedLoad();
  });
}

const debouncedLoad = debounce(loadData, 260);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

(async function init() {
  bindEvents();
  await loadData();
  handleRoute();
  if (location.hash === '#detect') openDetectModal();
  setInterval(() => {
    if (state.route === 'overview') renderTaskPanel();
  }, 30000);
})();
