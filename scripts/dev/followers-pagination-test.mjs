// 验证粉丝名单第 2 页起的补全流程：
// - 模拟「Followers 后续页重放失败」后的部分名单状态
// - 后台窗口打开真实粉丝页，页面自己滚动加载下一页
// - 捕获网页端响应并合并，最终得到完整粉丝名单
const PORT = 9333, EXT = 'lhjcbgklocfcaphoilhanbafgfmkaikl';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = async (p, m = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

/* ---------------- 基础 CDP 连接 ---------------- */

function mkConn(target) {
  const ws = new WebSocket(target);
  const pend = new Map();
  const handlers = new Map();
  let id = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method && handlers.has(m.method)) {
      for (const fn of handlers.get(m.method)) fn(m.params, m.sessionId);
    }
  };
  const ready = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}, sessionId) =>
    new Promise((r) => {
      const i = ++id;
      pend.set(i, r);
      const msg = { id: i, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    });
  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
  };
  return { ws, send, on, ready };
}

/* ---------------- 伪造页面 ---------------- */

function pageHtml(script = '') {
  return `<!doctype html><html><head><title>fake x</title></head>
<body style="margin:0"><div id="react-root"></div>${script}</body></html>`;
}

// 模拟 X 网页端：首屏拉第一页，滚动到底部再拉下一页
const harvestPageScript = `<script>
(function () {
  const qid = 'qidG';
  const base = '/i/api/graphql/' + qid + '/Followers?features=%7B%7D';
  let pages = 0, loading = false;
  function load(cursor) {
    if (loading) return;
    loading = true;
    const vars = encodeURIComponent(JSON.stringify({ userId: '42', count: 20, ...(cursor ? { cursor } : {}) }));
    fetch(base + '&variables=' + vars)
      .then((r) => r.text())
      .then(() => { pages += 1; loading = false; })
      .catch(() => { loading = false; });
  }
  load();
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:5900px;left:0;width:10px;height:10px';
  document.body.appendChild(sentinel);
  new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    window.__lanIoFired = (window.__lanIoFired || 0) + 1;
    if (pages < 2 && !loading) load('C1');
  }, { rootMargin: '300px' }).observe(sentinel);
  document.body.style.height = '6000px';
})();
</script>`;

function userEntry(id, sn, name) {
  return {
    entryId: 'user-' + id,
    content: { itemContent: { user_results: { result: { rest_id: id, core: { screen_name: sn, name } } } } },
  };
}

function timelineJson(entries, { cursor = null, terminate = false } = {}) {
  const list = [...entries];
  if (cursor) list.push({ entryId: 'cursor-bottom-' + cursor, content: { cursorType: 'Bottom', value: cursor } });
  const instructions = [{ type: 'TimelineAddEntries', entries: list }];
  if (terminate) instructions.push({ type: 'TimelineTerminateTimeline', direction: 'Bottom' });
  return { data: { user: { result: { timeline: { instructions } } } } };
}

const followingJson = timelineJson(
  [userEntry('9000001', 'alice', 'Alice'), userEntry('9000002', 'bob', 'Bob')],
  { terminate: true }
);
const followersPage1Json = timelineJson(
  [userEntry('9000002', 'bob', 'Bob'), userEntry('9000003', 'carol', 'Carol')],
  { cursor: 'C1' }
);
const followersPage2Json = timelineJson(
  [
    userEntry('9000004', 'dave', 'Dave'),
    userEntry('9000005', 'erin', 'Erin'),
    userEntry('9000006', 'frank', 'Frank'),
  ],
  { terminate: true }
);
const lookupJson = [
  { id_str: '9000001', connections: ['following', 'followed_by'] },
  { id_str: '9000002', connections: ['following', 'followed_by'] },
  { id_str: '9000003', connections: ['followed_by'] },
  { id_str: '9000004', connections: ['followed_by'] },
  { id_str: '9000005', connections: ['followed_by'] },
  { id_str: '9000006', connections: ['followed_by'] },
];

const reqs = [];
const pageUrls = new Map();
const servedDocs = new Set();

const browser = mkConn((await http('/json/version')).webSocketDebuggerUrl);
await browser.ready;

browser.on('Target.targetInfoChanged', ({ targetInfo }) => {
  if (targetInfo) pageUrls.set(targetInfo.targetId, targetInfo.url);
});

browser.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
  pageUrls.set(targetInfo.targetId, targetInfo.url);
  if (targetInfo.type === 'page') {
    await browser.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'https://x.com/*', requestStage: 'Request' },
        { urlPattern: 'https://twitter.com/*', requestStage: 'Request' },
      ],
    }, sessionId).catch(() => {});
    await browser.send('Runtime.enable', {}, sessionId).catch(() => {});
    await browser.send('Page.enable', {}, sessionId).catch(() => {});
  }
  await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});

  // 初始导航的请求可能在 Fetch 启用前就发出了；这时再导航一次，
  // 让模拟页面真正加载，内容脚本才会注入。
  if (targetInfo.type === 'page' && /^https:\/\/(x|twitter)\.com\//.test(targetInfo.url)) {
    setTimeout(async () => {
      if (servedDocs.has(sessionId)) return;
      await browser.send('Page.navigate', { url: targetInfo.url }, sessionId).catch(() => {});
    }, 400);
  }
});

async function fulfill(sessionId, requestId, status, body, headers = []) {
  try {
    await browser.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: headers,
      body: body === undefined ? undefined : Buffer.from(body).toString('base64'),
    }, sessionId);
  } catch (_) {}
}

const jsonHeaders = [
  { name: 'content-type', value: 'application/json' },
  { name: 'x-rate-limit-remaining', value: '100' },
];
const htmlHeaders = [{ name: 'content-type', value: 'text/html; charset=utf-8' }];

browser.on('Fetch.requestPaused', async (p, sessionId) => {
  const { requestId, request, resourceType } = p;
  const url = request.url;
  reqs.push(url);
  try {
    if (resourceType === 'Document') {
      servedDocs.add(sessionId);
      const path = new URL(url).pathname;
      const script = path.endsWith('/followers') ? harvestPageScript : '';
      return fulfill(sessionId, requestId, 200, pageHtml(script), htmlHeaders);
    }
    if (url.includes('/i/api/graphql/') && /\/Following(\?|$)/.test(url)) {
      return fulfill(sessionId, requestId, 200, JSON.stringify(followingJson), jsonHeaders);
    }
    if (url.includes('/i/api/graphql/') && /\/Followers(\?|$)/.test(url)) {
      // 第 1 页由网页端自己请求，第 2 页（带 cursor）也由网页端自己请求；
      // 工作页重放后续页在真实环境会 404，这里同样返回 404
      const decoded = decodeURIComponent(url);
      if (!/"cursor"/.test(decoded)) {
        return fulfill(sessionId, requestId, 200, JSON.stringify(followersPage1Json), jsonHeaders);
      }
      if (decoded.includes('"cursor":"C1"')) {
        // 粉丝页自己滚动加载的第二页
        return fulfill(sessionId, requestId, 200, JSON.stringify(followersPage2Json), jsonHeaders);
      }
      return fulfill(sessionId, requestId, 404, JSON.stringify({ errors: [{ message: 'not found' }] }), jsonHeaders);
    }
    if (url.includes('/i/api/1.1/friendships/lookup.json')) {
      return fulfill(sessionId, requestId, 200, JSON.stringify(lookupJson), jsonHeaders);
    }
    return fulfill(sessionId, requestId, 204, '');
  } catch (err) {
    console.log('FULFILL ERROR', err.message);
    fulfill(sessionId, requestId, 500, '');
  }
});

await browser.send('Target.setDiscoverTargets', { discover: true });
await browser.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'page' }],
});

/* ---------------- 工作页 ---------------- */

// 清掉上一次测试残留的 x.com 标签页，避免 sendMessage 发到错误的页面
for (const t of await http('/json/list')) {
  if (t.type === 'page' && /^https:\/\/(x|twitter)\.com\//.test(t.url)) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
  }
}

const workerTarget = (await browser.send('Target.createTarget', { url: 'https://x.com/home' })).result.targetId;
await sleep(1800);

/* ---------------- 控制页 ---------------- */

const dashTarget = (await browser.send('Target.createTarget', {
  url: `chrome-extension://${EXT}/src/ui/dashboard.html#/overview`,
})).result.targetId;
await sleep(2200);

const list = await http('/json/list');
const dashInfo = list.find((t) => t.id === dashTarget);
if (!dashInfo) throw new Error('找不到控制台页面');
const dash = mkConn(dashInfo.webSocketDebuggerUrl);
await dash.ready;
await dash.send('Runtime.enable');

const ev = async (expression, ms = 20000) => {
  const r = await Promise.race([
    dash.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((res) => setTimeout(() => res({ timeout: true }), ms)),
  ]);
  if (r.timeout) return { timeout: true };
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
};

/* ---------------- 种子数据 ---------------- */

const now = Date.now();
const account = { id: '42', screenName: 'tester', name: 'Tester', avatar: null, connectedAt: now, lastDetectAt: null };
const seed = {
  lanAccounts: [account],
  lanActive: '42',
  lanSettings: {
    pageDelayMs: 1500,
    lookupDelayMs: 1500,
    unfollowMinDelayMs: 4000,
    unfollowMaxDelayMs: 8000,
    limitDefault: 1000,
  },
  lanCaptures: {
    updatedAt: now,
    operations: {
      Following: {
        operation: 'Following', queryId: 'qidF', path: '/i/api/graphql/qidF/Following',
        fullPath: '/i/api/graphql/qidF/Following', method: 'GET', headers: {},
        variables: JSON.stringify({ userId: '42', count: 20 }),
        firstVariables: JSON.stringify({ userId: '42', count: 20 }),
        features: '{}', fieldToggles: null, transactionId: null, requestId: 'rF1', at: now,
      },
      Followers: {
        operation: 'Followers', queryId: 'qidG', path: '/i/api/graphql/qidG/Followers',
        fullPath: '/i/api/graphql/qidG/Followers', method: 'GET', headers: {},
        variables: JSON.stringify({ userId: '42', count: 20 }),
        firstVariables: JSON.stringify({ userId: '42', count: 20 }),
        features: '{}', fieldToggles: null, transactionId: null, requestId: 'rG1', at: now,
        lastBody: JSON.stringify(followersPage1Json), lastBodyRequestId: 'rG1',
        lastBodyAt: now, lastBodyStatus: 200,
      },
    },
  },
};
await ev(`chrome.storage.local.clear().then(()=>chrome.storage.local.set(${JSON.stringify(seed)}))`);
await sleep(300);

/* ---------------- 启动检测（粉丝名单已是部分状态） ---------------- */

const baseTask = {
  id: 'dpagination',
  type: 'detect',
  accountId: '42',
  account: { id: '42', screenName: 'tester', name: 'Tester', avatar: null },
  status: 'running',
  startedAt: now,
  updatedAt: now,
  endedAt: null,
  params: { limit: null },
  progress: { phase: '准备', message: '', done: 0, total: null },
  state: {
    // 模拟真实情况：第 1 页拿到了，后续页重放失败
    followers: {
      users: [
        { id: '9000002', screenName: 'bob', name: 'Bob', avatar: null, verified: false },
        { id: '9000003', screenName: 'carol', name: 'Carol', avatar: null, verified: false },
      ],
      cursor: 'C1',
      complete: true,
      partial: true,
      pages: 1,
    },
  },
  result: null,
  error: null,
};

const sent = await ev(`new Promise(r=>chrome.tabs.query({url:'https://x.com/*'},t=>{
  if(!t.length) return r({error:'no x tab'});
  chrome.tabs.sendMessage(t[0].id, ${JSON.stringify({ type: 'lan:cmd', command: 'detect', payload: { task: baseTask } })}, res=>r(res||{error:chrome.runtime.lastError?.message}));
}))`);
console.log('DETECT SENT', JSON.stringify(sent));

async function waitTask(id, timeoutMs = 90000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const t = await ev(`new Promise(r=>chrome.storage.local.get('lanTask',x=>r(x.lanTask)))`, 8000);
    if (t) last = t;
    if (t && t.id === id && ['done', 'error', 'interrupted', 'stopped'].includes(t.status)) return t;
    await sleep(500);
  }
  return { timeout: true, last };
}

const dt = await waitTask('dpagination');
console.log('DETECT TASK', JSON.stringify({
  status: dt.status,
  result: dt.result,
  progress: dt.progress,
  error: dt.error,
  timeout: dt.timeout,
}, null, 2));

const rels = await ev(`new Promise(r=>chrome.storage.local.get('lanRelations:42',x=>r(x['lanRelations:42'])))`);
console.log('RELATIONS', JSON.stringify(
  Object.fromEntries(Object.entries(rels || {}).map(([k, v]) => [k, {
    sn: v.screenName, following: v.following, followsMe: v.followsMe, stale: !!v.stale,
  }])),
  null, 2
));

const followersApiReqs = reqs.filter((u) => /\/Followers(\?|$)/.test(u));
console.log('FOLLOWERS REQUESTS', JSON.stringify(
  followersApiReqs.map((u) => (decodeURIComponent(u).match(/cursor":?"?([^"&]+)/) || [])[1] || 'page1'),
  null, 2
));

const wins = await ev(`new Promise(r=>chrome.windows.getAll({populate:true},w=>r(w.map(x=>({id:x.id,type:x.type,tabs:x.tabs.map(t=>t.url)})))))`);
console.log('WINDOWS AFTER', JSON.stringify(wins));

const ok =
  dt.status === 'done' &&
  dt.result &&
  dt.result.scannedFollowers === 5 &&
  dt.result.followersPartial === false &&
  rels['9000004'] && rels['9000005'] && rels['9000006'] && rels['9000004'].followsMe;

console.log(ok ? 'PASS: 粉丝第 2 页已通过页面滚动补全' : 'FAIL: 粉丝名单未补全');

for (const t of (await http('/json/list')).filter(
  (t) => t.type === 'page' && (t.url.startsWith('chrome-extension://') || t.url.startsWith('https://x.com'))
)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
browser.ws.close();
dash.ws.close();
process.exit(ok ? 0 : 1);
