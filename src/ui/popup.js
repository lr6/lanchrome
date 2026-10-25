/* 关注整理所 — Popup */

const $ = (sel) => document.querySelector(sel);

function send(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/dashboard.html' + hash) });
  window.close();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let overview = null;

async function load() {
  const res = await send('lan:overview');
  if (!res.ok) {
    toast(res.error || '读取数据失败', true);
    return;
  }
  overview = res.overview;
  render();
}

function render() {
  if (!overview) return;
  const { account, stats, task, version } = overview;

  $('#version').textContent = 'v' + version;

  const statusChip = $('#statusChip');
  if (account) {
    statusChip.classList.add('online');
    statusChip.innerHTML = '<span class="dot"></span>已连接';
  } else {
    statusChip.classList.remove('online');
    statusChip.innerHTML = '<span class="dot"></span>未连接';
  }

  const box = $('#accountBox');
  if (account) {
    const initial = escapeHtml((account.name || account.screenName || '?').slice(0, 1));
    box.innerHTML = `
      <div class="account-inner">
        ${
          account.avatar
            ? `<img class="avatar" src="${escapeHtml(account.avatar)}" alt="" />`
            : `<div class="avatar avatar-fallback">${initial}</div>`
        }
        <div class="account-meta">
          <div class="account-name">${escapeHtml(account.name || account.screenName)}</div>
          <div class="account-handle">@${escapeHtml(account.screenName)}</div>
        </div>
        <span class="chip ${account.lastDetectAt ? 'mint' : 'blue'}">${
          account.lastDetectAt ? '已检测' : '待检测'
        }</span>
      </div>`;
  } else {
    box.innerHTML = `
      <div class="account-empty">
        <p>用当前浏览器登录的 X 账号开始检测，数据只留在这台电脑。</p>
        <button class="btn soft sm block" id="connectBtn">连接 X 账号</button>
      </div>`;
    $('#connectBtn').addEventListener('click', connect);
  }

  for (const [key, value] of Object.entries(stats)) {
    const el = document.querySelector(`[data-stat="${key}"]`);
    if (el) el.textContent = value == null ? '—' : value.toLocaleString('zh-CN');
  }

  const taskBox = $('#taskBox');
  const visible =
    task && ['running', 'interrupted', 'stopped', 'error'].includes(task.status);
  taskBox.classList.toggle('hidden', !visible);
  if (visible) {
    const p = task.progress || {};
    $('#taskPhase').textContent = p.phase || '任务';
    const done = p.done || 0;
    const total = p.total || 0;
    $('#taskCount').textContent = total ? `${done} / ${total}` : '';
    $('#taskMsg').textContent = p.message || '';
    $('#taskBar').style.width = total ? Math.min(100, (done / total) * 100) + '%' : '12%';
    if (!total) $('#taskBar').style.width = task.status === 'running' ? '24%' : '100%';
  }

  $('#quickDetect').textContent = task && task.status === 'running' ? '检测进行中' : '开始检测';
  $('#quickDetect').disabled = !account || (task && task.status === 'running');
}

async function connect() {
  const btn = $('#connectBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在连接…';
  }
  const res = await send('lan:connect');
  if (!res.ok) {
    toast(res.error || '连接失败', true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '连接 X 账号';
    }
    return;
  }
  toast('已连接 @' + res.account.screenName);
  await load();
}

$('#openDashboard').addEventListener('click', () => openDashboard(''));
$('#openRelations').addEventListener('click', () => openDashboard('#/relations'));
$('#quickDetect').addEventListener('click', async () => {
  const limit = overview && overview.settings ? overview.settings.limitDefault : 1000;
  const res = await send('lan:start-detect', { options: { limit } });
  if (!res.ok) {
    toast(res.error || '启动失败', true);
    return;
  }
  openDashboard('#/overview');
});

document.querySelectorAll('[data-filter]').forEach((el) => {
  el.addEventListener('click', () => openDashboard('#/relations?filter=' + el.dataset.filter));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lanTask || changes.lanAccounts || changes.lanActive) load();
});

load();
