/**
 * 关注整理所 / TidyFollows — Background Service Worker
 * 负责：账号连接、任务编排、标签页管理、接口参数预热与缓存、任务中断处理。
 * 所有业务数据保存在 chrome.storage.local，不上传任何服务器。
 */

const X_TAB = /^https:\/\/(x|twitter)\.com\//;

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

const readyTabs = new Set();

/* -------------------------------------------------------------------- */
/* 存储                                                                  */
/* -------------------------------------------------------------------- */

const store = {
  async get(key, fallback) {
    const out = await chrome.storage.local.get(key);
    return out[key] === undefined ? fallback : out[key];
  },
  async set(obj) {
    await chrome.storage.local.set(obj);
  },
};

async function getActiveAccount() {
  const id = await store.get('lanActive', null);
  if (!id) return null;
  const accounts = (await store.get('lanAccounts', [])) || [];
  return accounts.find((a) => a.id === id) || null;
}

/* -------------------------------------------------------------------- */
/* 初始化                                                                */
/* -------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await store.get('lanSettings', null);
  if (!settings) await store.set({ lanSettings: DEFAULT_SETTINGS });
  const accounts = await store.get('lanAccounts', null);
  if (!accounts) await store.set({ lanAccounts: [] });

  chrome.alarms.create('lan-housekeeping', { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('lan-housekeeping', { periodInMinutes: 1 });

  // 浏览器重启后旧任务不可能还在跑，直接标记为可继续
  const task = await store.get('lanTask', null);
  if (task && task.status === 'running') {
    const saved = await store.get('lanWorkerTab', null);
    let alive = false;
    if (saved && saved.tabId) {
      try {
        const tab = await chrome.tabs.get(saved.tabId);
        alive = !!(tab && tab.url && X_TAB.test(tab.url));
      } catch (_) {}
    }
    if (!alive) {
      await markInterrupted('浏览器已重启，任务中断，可继续上次进度');
    }
  }
});

/* -------------------------------------------------------------------- */
/* 标签页                                                                */
/* -------------------------------------------------------------------- */

function waitForReady(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (readyTabs.has(tabId)) return resolve(true);
    const started = Date.now();
    const timer = setInterval(async () => {
      if (readyTabs.has(tabId)) {
        clearInterval(timer);
        return resolve(true);
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        return reject(new Error('X 页面加载超时，请打开 x.com 后重试'));
      }
      try {
        await chrome.tabs.get(tabId);
      } catch (_) {
        clearInterval(timer);
        reject(new Error('用于执行任务的 X 页面已被关闭'));
      }
    }, 300);
  });
}

async function getWarmups() {
  try {
    const out = await chrome.storage.session.get('lanWarmups');
    return out.lanWarmups || {};
  } catch (_) {
    return {};
  }
}

async function setWarmups(map) {
  try {
    await chrome.storage.session.set({ lanWarmups: map });
  } catch (_) {}
}

async function getHarvestTabs() {
  try {
    const out = await chrome.storage.session.get('lanHarvestTabs');
    return out.lanHarvestTabs || {};
  } catch (_) {
    return {};
  }
}

async function setHarvestTabs(map) {
  try {
    await chrome.storage.session.set({ lanHarvestTabs: map });
  } catch (_) {}
}

async function ensureWorkerTab() {
  const warmups = await getWarmups();
  const harvests = await getHarvestTabs();
  const saved = await store.get('lanWorkerTab', null);

  if (saved && saved.tabId && !warmups[saved.tabId] && !harvests[saved.tabId]) {
    try {
      const tab = await chrome.tabs.get(saved.tabId);
      if (tab && tab.url && X_TAB.test(tab.url)) return tab.id;
    } catch (_) {}
  }

  for (const id of readyTabs) {
    if (warmups[id] || harvests[id]) continue;
    try {
      const tab = await chrome.tabs.get(id);
      if (tab && tab.url && X_TAB.test(tab.url)) {
        await store.set({ lanWorkerTab: { tabId: id, at: Date.now() } });
        return id;
      }
    } catch (_) {
      readyTabs.delete(id);
    }
  }

  const tab = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
  await store.set({ lanWorkerTab: { tabId: tab.id, at: Date.now() } });
  await waitForReady(tab.id, 35000);
  return tab.id;
}

async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/page/agent.js'],
      world: 'MAIN',
    });
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/page/bridge.js'],
      world: 'ISOLATED',
    });
  } catch (_) {}
}

async function sendToWorker(command, payload) {
  const tabId = await ensureWorkerTab();
  const message = { type: 'lan:cmd', command, payload };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    readyTabs.delete(tabId);
    // 页面可能早于扩展安装打开，补注入后再试
    await injectContentScripts(tabId);
    await waitForReady(tabId, 10000).catch(() => {});
    return chrome.tabs.sendMessage(tabId, message);
  }
}

/* -------------------------------------------------------------------- */
/* 接口参数预热                                                          */
/* -------------------------------------------------------------------- */

function capturesUsable(caps, ops = ['Following', 'Followers']) {
  if (!caps || !caps.operations) return false;
  return ops.every((op) => caps.operations[op] && caps.operations[op].queryId);
}

async function openWarmupTabs(account, { force = false } = {}) {
  if (!account || !account.screenName) throw new Error('请先连接 X 账号');
  const caps = await store.get('lanCaptures', null);
  const ops = [
    { op: 'Following', url: `https://x.com/${encodeURIComponent(account.screenName)}/following` },
    { op: 'Followers', url: `https://x.com/${encodeURIComponent(account.screenName)}/followers` },
  ];
  const warmups = await getWarmups();
  const opened = [];

  for (const { op, url } of ops) {
    const cached = caps && caps.operations && caps.operations[op];
    const fresh = cached && Date.now() - (cached.at || 0) < 30 * 60 * 1000;
    if (!force && fresh) continue;
    const tab = await chrome.tabs.create({ url, active: false });
    warmups[tab.id] = { op, at: Date.now(), url };
    opened.push(tab.id);
  }
  await setWarmups(warmups);
  return opened;
}

/* -------------------------------------------------------------------- */
/* 粉丝页滚动采集                                                        */
/* -------------------------------------------------------------------- */

async function closeHarvestTab(tabId) {
  const harvests = await getHarvestTabs();
  if (harvests[tabId]) {
    delete harvests[tabId];
    await setHarvestTabs(harvests);
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {}
}

async function openHarvestTab(account, taskId) {
  // 同一时间只保留一个采集窗口。先清空登记再关标签页，
  // 避免旧标签页的 onRemoved 把错误状态写进本次任务。
  const harvests = await getHarvestTabs();
  if (Object.keys(harvests).length) {
    await setHarvestTabs({});
    for (const id of Object.keys(harvests)) {
      try {
        await chrome.tabs.remove(Number(id));
      } catch (_) {}
    }
  }

  const url = `https://x.com/${encodeURIComponent(account.screenName)}/followers`;
  // focused:false 的非最小化窗口仍然算「可见」，IntersectionObserver/滚动加载才会工作，
  // 同时不会抢走用户当前窗口的焦点。
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    focused: false,
    width: 420,
    height: 560,
    top: 60,
    left: 60,
  });
  let tab = win && win.tabs && win.tabs[0];
  if (!tab && win && win.id) {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    tab = tabs && tabs[0];
  }
  if (!tab) {
    if (win && win.id) chrome.windows.remove(win.id).catch(() => {});
    throw new Error('无法打开粉丝页面');
  }

  await setHarvestTabs({
    [tab.id]: { taskId, windowId: win.id, at: Date.now() },
  });
  // 避免被浏览器的内存节省功能回收
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  try {
    await waitForReady(tab.id, 35000);
  } catch (err) {
    await closeHarvestTab(tab.id);
    throw err;
  }
  return tab.id;
}

async function sendHarvestCommand(tabId, command, payload) {
  const message = { type: 'lan:cmd', command, payload };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    await injectContentScripts(tabId);
    await waitForReady(tabId, 10000).catch(() => {});
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function mergeCapture(operation) {
  if (!operation || !operation.operation) return;
  const caps = (await store.get('lanCaptures', null)) || { operations: {}, updatedAt: 0 };
  caps.operations = caps.operations || {};
  caps.operations[operation.operation] = {
    ...(caps.operations[operation.operation] || {}),
    ...operation,
    at: Date.now(),
  };
  caps.updatedAt = Date.now();
  await store.set({ lanCaptures: caps });
}

async function mergeCaptureResult(result) {
  if (!result || !result.operation) return;
  const caps = await store.get('lanCaptures', null);
  if (!caps || !caps.operations) return;
  const info = caps.operations[result.operation];
  if (!info) return;
  // 只记录与最新一次捕获对应的响应状态
  if (info.requestId && result.requestId && info.requestId !== result.requestId) return;
  info.lastStatus = result.status;
  info.lastStatusAt = result.at;
  caps.updatedAt = Date.now();
  await store.set({ lanCaptures: caps });
}

async function mergeCaptureBody(body) {
  if (!body || !body.operation || !body.text) return;
  const caps = await store.get('lanCaptures', null);
  if (!caps || !caps.operations) return;
  const info = caps.operations[body.operation];
  if (!info) return;
  // 响应可能晚于请求捕获到达，这里以最新一次捕获的 requestId 为准
  info.lastBody = body.text;
  info.lastBodyAt = body.at;
  info.lastBodyStatus = body.status;
  info.lastBodyRequestId = info.requestId || body.requestId;
  caps.bodyDebug = caps.bodyDebug || {};
  caps.bodyDebug[body.operation] = { at: body.at, size: body.text.length, requestId: body.requestId };
  caps.updatedAt = Date.now();
  await store.set({ lanCaptures: caps });
}

// 同一页面可能连续发出多条请求，串行合并避免读改写竞态
let captureChain = Promise.resolve();
function queueCapture(operation) {
  captureChain = captureChain.then(
    () => mergeCapture(operation),
    () => mergeCapture(operation)
  );
  return captureChain;
}
function queueCaptureResult(result) {
  captureChain = captureChain.then(
    () => mergeCaptureResult(result),
    () => mergeCaptureResult(result)
  );
  return captureChain;
}
function queueCaptureBody(body) {
  captureChain = captureChain.then(
    () => mergeCaptureBody(body),
    () => mergeCaptureBody(body)
  );
  return captureChain;
}

/* -------------------------------------------------------------------- */
/* 任务                                                                  */
/* -------------------------------------------------------------------- */

async function startDetect(options = {}) {
  const account = await getActiveAccount();
  if (!account) throw new Error('请先连接 X 账号');

  const prev = await store.get('lanTask', null);
  if (prev && prev.status === 'running' && !options.resume) {
    throw new Error('已有任务正在运行，请先停止或等待完成');
  }
  let task;

  if (
    options.resume &&
    prev &&
    prev.type === 'detect' &&
    prev.accountId === account.id &&
    ['interrupted', 'stopped', 'error', 'done'].includes(prev.status)
  ) {
    task = prev;
    task.status = 'running';
    task.error = null;
    task.dismissed = false;
    task.endedAt = null;
    task.updatedAt = Date.now();
    task.progress = { phase: '准备', message: '正在继续上次检测…', done: 0, total: null };
  } else {
    task = {
      id: 'd' + Date.now().toString(36),
      type: 'detect',
      accountId: account.id,
      account: {
        id: account.id,
        screenName: account.screenName,
        name: account.name,
        avatar: account.avatar,
      },
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
      params: { limit: Number(options.limit) > 0 ? Number(options.limit) : null },
      progress: { phase: '准备', message: '正在启动检测…', done: 0, total: null },
      state: {},
      result: null,
      error: null,
    };
  }

  await store.set({ lanTask: task });
  let res;
  try {
    res = await sendToWorker('detect', { task });
  } catch (err) {
    task.status = 'error';
    task.error = err && err.message ? err.message : String(err);
    task.progress = { phase: '出错', message: task.error };
    task.updatedAt = Date.now();
    await store.set({ lanTask: task });
    throw new Error(task.error);
  }
  if (!res || !res.ok) {
    task.status = 'error';
    task.error = (res && res.error) || '任务启动失败';
    task.progress = { phase: '出错', message: task.error };
    task.updatedAt = Date.now();
    await store.set({ lanTask: task });
    throw new Error(task.error);
  }
  return task;
}

async function startUnfollow(payload = {}) {
  const account = await getActiveAccount();
  if (!account) throw new Error('请先连接 X 账号');
  const ids = Array.isArray(payload.items) ? payload.items : [];

  const prev = await store.get('lanTask', null);
  if (prev && prev.status === 'running' && !payload.resume) {
    throw new Error('已有任务正在运行，请先停止或等待完成');
  }
  const canResume =
    !!payload.resume &&
    !!prev &&
    prev.type === 'unfollow' &&
    prev.accountId === account.id &&
    ['interrupted', 'stopped', 'error'].includes(prev.status) &&
    prev.state &&
    Array.isArray(prev.state.items) &&
    prev.state.index < prev.state.items.length;

  if (!ids.length && !canResume) throw new Error('没有选择要取关的账号');

  let task;

  if (canResume) {
    task = prev;
    task.status = 'running';
    task.error = null;
    task.dismissed = false;
    task.endedAt = null;
    task.updatedAt = Date.now();
    task.progress = {
      phase: '批量取关',
      message: '正在继续上次任务…',
      done: task.state.index,
      total: task.state.items.length,
    };
  } else {
    task = {
      id: 'u' + Date.now().toString(36),
      type: 'unfollow',
      accountId: account.id,
      account: {
        id: account.id,
        screenName: account.screenName,
        name: account.name,
        avatar: account.avatar,
      },
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
      params: {},
      progress: { phase: '批量取关', message: '正在准备…', done: 0, total: ids.length },
      state: { items: ids, index: 0, results: [] },
      result: null,
      error: null,
    };
  }

  await store.set({ lanTask: task });
  const res = await sendToWorker('unfollow', { task });
  if (!res || !res.ok) {
    task.status = 'error';
    task.error = (res && res.error) || '任务启动失败';
    task.updatedAt = Date.now();
    await store.set({ lanTask: task });
    throw new Error(task.error);
  }
  return task;
}

async function markInterrupted(reason) {
  const task = await store.get('lanTask', null);
  if (!task || task.status !== 'running') return;
  task.status = 'interrupted';
  task.updatedAt = Date.now();
  task.error = reason;
  task.progress = { ...(task.progress || {}), phase: '已中断', message: reason };
  await store.set({ lanTask: task });
}

/* -------------------------------------------------------------------- */
/* 概览数据                                                              */
/* -------------------------------------------------------------------- */

async function buildOverview() {
  const account = await getActiveAccount();
  const accounts = (await store.get('lanAccounts', [])) || [];
  const task = await store.get('lanTask', null);
  const storedSettings = await store.get('lanSettings', {});
  const settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    // 时间间隔固定，旧设置/备份不会覆盖
    ...FIXED_INTERVALS,
    limitDefault:
      Number(storedSettings.limitDefault) > 0
        ? Number(storedSettings.limitDefault)
        : DEFAULT_SETTINGS.limitDefault,
  };
  const caps = await store.get('lanCaptures', null);

  let relations = {};
  let protectedMap = {};
  let history = [];
  let scan = null;
  if (account) {
    relations = (await store.get(`lanRelations:${account.id}`, {})) || {};
    protectedMap = (await store.get(`lanProtected:${account.id}`, {})) || {};
    history = (await store.get(`lanHistory:${account.id}`, [])) || [];
    scan = await store.get(`lanScan:${account.id}`, null);
  }

  const values = Object.values(relations).filter(
    (r) => !scan || r.scanId === scan.taskId || r.protected
  );
  const stats = {
    mutual: values.filter((r) => r.following && r.followsMe).length,
    notFollowingBack: values.filter((r) => r.following && !r.followsMe).length,
    notFollowedByMe: values.filter((r) => r.followsMe && !r.following).length,
    total: values.length,
    protected: Object.keys(protectedMap).length,
  };
  if (scan && scan.followersUnavailable) stats.notFollowedByMe = null;

  return {
    account,
    accounts: accounts.map((a) => ({
      id: a.id,
      screenName: a.screenName,
      name: a.name,
      avatar: a.avatar,
      lastDetectAt: a.lastDetectAt || null,
    })),
    task,
    stats,
    scan,
    history,
    settings,
    hasTemplates: capturesUsable(caps),
    capturesAt: caps ? caps.updatedAt || null : null,
    version: chrome.runtime.getManifest().version,
    now: Date.now(),
  };
}

/* -------------------------------------------------------------------- */
/* 消息分发                                                              */
/* -------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('lan:')) return;

  (async () => {
    switch (msg.type) {
      case 'lan:hello': {
        if (sender.tab && sender.tab.id) readyTabs.add(sender.tab.id);
        return { ok: true };
      }
      case 'lan:capture-result': {
        await queueCaptureResult(msg.result);
        return { ok: true };
      }
      case 'lan:capture-body': {
        await queueCaptureBody(msg.body);
        return { ok: true };
      }
      case 'lan:capture': {
        await queueCapture(msg.operation);
        if (sender.tab && sender.tab.id) {
          const warmups = await getWarmups();
          const entry = warmups[sender.tab.id];
          if (entry && entry.op === msg.operation.operation) {
            delete warmups[sender.tab.id];
            await setWarmups(warmups);
            setTimeout(() => {
              chrome.tabs.remove(sender.tab.id).catch(() => {});
            }, 4000);
          }
        }
        return { ok: true };
      }
      case 'lan:task-unloading': {
        const task = await store.get('lanTask', null);
        if (task && task.id === msg.taskId && task.status === 'running') {
          await markInterrupted('执行页被关闭或刷新，任务已中断，可继续上次进度');
        }
        return { ok: true };
      }
      case 'lan:warmup': {
        const account = msg.account || (await getActiveAccount());
        const opened = await openWarmupTabs(account, { force: !!msg.force });
        return { ok: true, opened };
      }
      case 'lan:harvest-followers': {
        const account = msg.account || (await getActiveAccount());
        if (!account || !account.screenName) throw new Error('请先连接 X 账号');
        const tabId = await openHarvestTab(account, msg.taskId);
        const started = await sendHarvestCommand(tabId, 'harvest', {
          taskId: msg.taskId,
          limit: msg.limit,
        });
        if (!started || !started.ok) {
          await closeHarvestTab(tabId);
          throw new Error((started && started.error) || '无法开始读取粉丝页面');
        }
        return { ok: true, tabId };
      }
      case 'lan:harvest-done': {
        if (sender.tab && sender.tab.id) await closeHarvestTab(sender.tab.id);
        return { ok: true };
      }
      case 'lan:harvest-stop': {
        const harvests = await getHarvestTabs();
        for (const [id, info] of Object.entries(harvests)) {
          if (info.taskId !== msg.taskId) continue;
          try {
            await sendHarvestCommand(Number(id), 'harvest-stop', {});
          } catch (_) {}
          setTimeout(() => {
            chrome.tabs.remove(Number(id)).catch(() => {});
          }, 4000);
          delete harvests[id];
        }
        await setHarvestTabs(harvests);
        return { ok: true };
      }
      case 'lan:connect': {
        const account = await sendToWorker('connect');
        if (!account || !account.ok || !account.account) {
          throw new Error((account && account.error) || '连接失败');
        }
        const accounts = (await store.get('lanAccounts', [])) || [];
        const idx = accounts.findIndex((a) => a.id === account.account.id);
        const merged = { ...(idx >= 0 ? accounts[idx] : {}), ...account.account };
        if (idx >= 0) accounts[idx] = merged;
        else accounts.push(merged);
        await store.set({ lanAccounts: accounts, lanActive: merged.id });
        return { ok: true, account: merged };
      }
      case 'lan:start-detect': {
        const task = await startDetect(msg.options || {});
        return { ok: true, task };
      }
      case 'lan:start-unfollow': {
        const task = await startUnfollow(msg.payload || {});
        return { ok: true, task };
      }
      case 'lan:cancel': {
        const res = await sendToWorker('cancel', {});
        return res || { ok: true };
      }
      case 'lan:selftest': {
        const res = await sendToWorker('selftest', {});
        return res || { ok: false, error: '自检没有返回结果' };
      }
      case 'lan:overview': {
        return { ok: true, overview: await buildOverview() };
      }
      case 'lan:ensure-templates': {
        const account = await getActiveAccount();
        const opened = await openWarmupTabs(account, { force: !!msg.force });
        return { ok: true, opened };
      }
      case 'lan:set-active': {
        const accounts = (await store.get('lanAccounts', [])) || [];
        if (!accounts.some((a) => a.id === msg.accountId)) throw new Error('账号不存在');
        await store.set({ lanActive: msg.accountId });
        return { ok: true };
      }
      default:
        return { ok: false, error: '未知消息：' + msg.type };
    }
  })()
    .then((result) => sendResponse(result))
    .catch((err) =>
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) })
    );

  return true;
});

/* -------------------------------------------------------------------- */
/* 标签页生命周期                                                        */
/* -------------------------------------------------------------------- */

chrome.tabs.onRemoved.addListener(async (tabId) => {
  readyTabs.delete(tabId);
  const saved = await store.get('lanWorkerTab', null);
  if (saved && saved.tabId === tabId) {
    await store.set({ lanWorkerTab: null });
    await markInterrupted('执行页被关闭，任务已中断，可继续上次进度');
  }
  const warmups = await getWarmups();
  if (warmups[tabId]) {
    delete warmups[tabId];
    await setWarmups(warmups);
  }

  // 采集窗口被手动关闭时，通知正在等待的检测任务，别让它一直等到超时
  const harvests = await getHarvestTabs();
  const harvestInfo = harvests[tabId];
  if (harvestInfo) {
    delete harvests[tabId];
    await setHarvestTabs(harvests);
    const key = `lanHarvest:${harvestInfo.taskId}`;
    const current = await store.get(key, null);
    if (!current || !current.done) {
      await store.set({
        [key]: {
          taskId: harvestInfo.taskId,
          op: 'Followers',
          count: (current && current.count) || 0,
          pages: (current && current.pages) || 0,
          done: true,
          error: '粉丝页面已关闭',
          users: [],
          at: Date.now(),
        },
      });
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const saved = await store.get('lanWorkerTab', null);
  if (saved && saved.tabId === tabId && !X_TAB.test(changeInfo.url)) {
    await store.set({ lanWorkerTab: null });
    readyTabs.delete(tabId);
    await markInterrupted('执行页已离开 X，任务中断，可继续上次进度');
  }
});

/* -------------------------------------------------------------------- */
/* 定时维护                                                              */
/* -------------------------------------------------------------------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'lan-housekeeping') return;

  // 清理超时未关闭的预热标签页
  try {
    const warmups = await getWarmups();
    let changed = false;
    for (const [id, info] of Object.entries(warmups)) {
      if (Date.now() - info.at > 90 * 1000) {
        delete warmups[id];
        changed = true;
        chrome.tabs.remove(Number(id)).catch(() => {});
      }
    }
    if (changed) await setWarmups(warmups);
  } catch (_) {}

  // 清理异常残留的粉丝采集窗口
  try {
    const harvests = await getHarvestTabs();
    let changed = false;
    for (const [id, info] of Object.entries(harvests)) {
      if (Date.now() - info.at > 35 * 60 * 1000) {
        delete harvests[id];
        changed = true;
        chrome.tabs.remove(Number(id)).catch(() => {});
      }
    }
    if (changed) await setHarvestTabs(harvests);
  } catch (_) {}

  // 长时间无进展的任务视为中断
  const task = await store.get('lanTask', null);
  if (task && task.status === 'running' && Date.now() - (task.updatedAt || 0) > 6 * 60 * 1000) {
    await markInterrupted('任务长时间无响应，已标记为中断，可继续上次进度');
  }
});
