/**
 * 验证：在 x.com 网页端手动关注 / 取关后，扩展能实时更新本机关系记录；
 * 关系页会显示检测快照提示与「重新检测」入口。
 *
 * 前置：已用 Chrome for Testing / Playwright Chromium 以 --load-extension 启动，
 * 并开启 --remote-debugging-port=9333（见 scripts/dev/README.md）。
 */
const PORT = 9333;
const j = async (p, m = 'GET') =>
  (await (await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m })).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkConn(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pend = new Map();
  const events = [];
  let id = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    } else if (m.method) events.push(m);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pend.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ready = new Promise((r, jj) => {
    ws.onopen = r;
    ws.onerror = jj;
  });
  return { ws, send, events, ready };
}

async function evalIn(cdp, expression, ms = 15000) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((res) => setTimeout(() => res({ timeout: true }), ms)),
  ]);
  if (r.timeout) return { timeout: true };
  return r.result?.exceptionDetails
    ? { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text }
    : r.result?.result?.value;
}

async function findExtensionId() {
  for (let i = 0; i < 20; i++) {
    const list = await j('/json/list');
    const sw = list.find(
      (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://')
    );
    if (sw) return new URL(sw.url).host;
    await sleep(250);
  }
  throw new Error('没有找到已加载的扩展，请确认测试浏览器用了 --load-extension');
}

// ---- 模拟 x.com 页面 ----
const fakeTarget = await j('/json/new?about:blank', 'PUT');
const fake = mkConn(fakeTarget);
await fake.ready;
await fake.send('Runtime.enable');
await fake.send('Page.enable');
await fake.send('Fetch.enable', { patterns: [{ urlPattern: 'https://x.com/*', requestStage: 'Request' }] });

const lookupState = new Map();
let reqs = [];
fake.ws.addEventListener('message', async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request, resourceType } = m.params;
  const url = request.url;
  reqs.push(url);
  let status = 204;
  let body = '';
  let headers = [];
  if (resourceType === 'Document') {
    status = 200;
    headers = [{ name: 'content-type', value: 'text/html; charset=utf-8' }];
    body = Buffer.from(
      '<!doctype html><html><head><title>fake x</title></head><body>' +
        '<a data-testid="AppTabBar_Profile_Link" href="/tester">Profile</a>' +
        '<div id="react-root"></div></body></html>'
    ).toString('base64');
  } else if (url.includes('/i/api/1.1/friendships/lookup.json')) {
    const id = (decodeURIComponent(url).match(/user_id=(\d+)/) || [])[1];
    const info = lookupState.get(id);
    status = 200;
    headers = [{ name: 'content-type', value: 'application/json' }];
    body = Buffer.from(
      JSON.stringify(
        info
          ? [
              {
                id: Number(id),
                id_str: id,
                name: info.name,
                screen_name: info.screenName,
                profile_image_url_https: `https://pbs.twimg.com/profile_images/1/${info.screenName}_normal.jpg`,
                connections: info.connections,
              },
            ]
          : []
      )
    ).toString('base64');
  } else if (url.includes('/CreateFriendship') || url.includes('/DestroyFriendship')) {
    status = 200;
    headers = [{ name: 'content-type', value: 'application/json' }];
    body = Buffer.from('{"data":{}}').toString('base64');
  }
  try {
    await fake.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: headers,
      body: body || undefined,
    });
  } catch (_) {}
});

await fake.send('Page.navigate', { url: 'https://x.com/home' });
await sleep(1500);

// 内容脚本上报 hello 后扩展 Service Worker 才会出现在目标列表里
const EXT = await findExtensionId();
console.log('EXTENSION', EXT);

// ---- 预置数据 + 打开仪表盘 ----
const dashTarget = await j('/json/new?about:blank', 'PUT');
const dash = mkConn(dashTarget);
await dash.ready;
await dash.send('Runtime.enable');
await dash.send('Page.enable');
await dash.send('Page.navigate', { url: `chrome-extension://${EXT}/src/ui/dashboard.html#/relations` });
await sleep(900);

const now = Date.now();
const account = { id: '42', screenName: 'tester', name: 'Tester', avatar: null, connectedAt: now, lastDetectAt: now };
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
  'lanRelations:42': {
    9000003: {
      id: '9000003',
      screenName: 'carol',
      name: 'Carol',
      avatar: null,
      following: false,
      followsMe: true,
      protected: false,
      firstSeen: now - 2000,
      lastSeen: now - 2000,
      scannedAt: now - 2000,
      scanId: 'dtest',
      stale: false,
      unfollowedAt: null,
    },
  },
  'lanScan:42': {
    taskId: 'dtest',
    at: now - 60000,
    stats: { mutual: 0, notFollowingBack: 0, notFollowedByMe: 1, total: 1 },
    scannedFollowing: 0,
    scannedFollowers: 1,
    followersPartial: true,
    approximate: true,
  },
};

await evalIn(dash, `chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(seed)}))`);
await sleep(300);
await dash.send('Page.reload');
await sleep(1200);

const getRelations = () =>
  evalIn(dash, `new Promise(r => chrome.storage.local.get('lanRelations:42', x => r(x['lanRelations:42'])))`);
const getScan = () =>
  evalIn(dash, `new Promise(r => chrome.storage.local.get('lanScan:42', x => r(x['lanScan:42'])))`);

async function waitFor(fn, predicate, timeoutMs = 8000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last && predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

const problems = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`);
  if (!ok) problems.push(name + (detail ? ` (${detail})` : ''));
}

// ---- 1. 关注：新建关系记录 ----
lookupState.set('9000004', {
  name: 'Dave',
  screenName: 'dave',
  connections: ['following'],
});
const followStatus = await evalIn(
  fake,
  `fetch('/i/api/graphql/qidCreate/CreateFriendship?variables=' + encodeURIComponent(JSON.stringify({ user_id: '9000004' })), { method: 'POST', credentials: 'include' }).then(r => r.status)`
);
const relsAfterFollow = await waitFor(getRelations, (r) => r && r['9000004']);
const dave = relsAfterFollow && relsAfterFollow['9000004'];
check('关注后写入关系', !!dave && dave.following === true, `status=${followStatus}`);
check('使用 lookup 补全资料', !!dave && dave.screenName === 'dave' && dave.name === 'Dave');
check('头像归一化为 200x200', !!dave && /_200x200\./.test(dave.avatar || ''));
check('新记录归入当前检测范围', !!dave && dave.scanId === 'dtest');
check('标记 liveAt', !!dave && !!dave.liveAt);

const dashAfterFollow = await waitFor(
  () => evalIn(dash, `document.body.innerText`),
  (text) => /dave/i.test(text || '')
);
check('关系页出现 dave', /dave/i.test(dashAfterFollow || ''), 'notFollowingBack 列表');
check('显示「已同步」标记', /已同步/.test(dashAfterFollow || ''));

// ---- 1b. 旧版 REST 关注入口 ----
lookupState.set('9000006', { name: 'Frank', screenName: 'frank', connections: ['following'] });
const restStatus = await evalIn(
  fake,
  `fetch('/i/api/1.1/friendships/create.json', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user_id=9000006' }).then(r => r.status)`
);
const relsAfterRest = await waitFor(getRelations, (r) => r && r['9000006']);
const frank = relsAfterRest && relsAfterRest['9000006'];
check('REST 关注入口', !!frank && frank.following === true && frank.screenName === 'frank', `status=${restStatus}`);

// ---- 2. 快照提示与重新检测入口 ----
const noticeText = await evalIn(dash, `document.querySelector('#scanNotice')?.innerText || ''`);
check('显示快照提示', /检测结果/.test(noticeText) && /重新检测/.test(noticeText), noticeText.replace(/\s+/g, ' '));
const modalText = await evalIn(
  dash,
  `(document.querySelector('#scanNoticeRedetect').click(), document.querySelector('#modalRoot').innerText)`
);
check('重新检测按钮可用', /开始检测/.test(modalText || ''));
await evalIn(dash, `document.querySelector('#modalRoot').innerHTML = ''`);

// ---- 3. 取关：更新已有记录 ----
lookupState.set('9000004', { name: 'Dave', screenName: 'dave', connections: [] });
const unfollowStatus = await evalIn(
  fake,
  `fetch('/i/api/graphql/qidDestroy/DestroyFriendship?variables=' + encodeURIComponent(JSON.stringify({ user_id: '9000004' })), { method: 'POST', credentials: 'include' }).then(r => r.status)`
);
const relsAfterUnfollow = await waitFor(getRelations, (r) => r && r['9000004'] && r['9000004'].following === false);
const dave2 = relsAfterUnfollow && relsAfterUnfollow['9000004'];
check('取关后更新关系', !!dave2 && dave2.following === false, `status=${unfollowStatus}`);
check('记录取关时间', !!dave2 && !!dave2.unfollowedAt);

// ---- 4. 页面账号与追踪账号不一致时不写入 ----
await evalIn(
  fake,
  `document.querySelector('a[data-testid="AppTabBar_Profile_Link"]').setAttribute('href', '/someone_else')`
);
lookupState.set('9000005', { name: 'Eve', screenName: 'eve', connections: ['following'] });
await evalIn(
  fake,
  `fetch('/i/api/graphql/qidCreate/CreateFriendship?variables=' + encodeURIComponent(JSON.stringify({ user_id: '9000005' })), { method: 'POST', credentials: 'include' }).then(r => r.status)`
);
await sleep(1500);
const relsAfterMismatch = await getRelations();
check('不匹配的页面账号不写入', !relsAfterMismatch['9000005']);

const scanAfter = await getScan();
check('检测快照本身不被改写', !!scanAfter && scanAfter.stats.notFollowedByMe === 1);

const exceptions = [...fake.events, ...dash.events]
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
  .filter((x) => !/Failed to load resource|net::ERR_/.test(x || ''));
check('无脚本异常', exceptions.length === 0, exceptions.join(' | '));

console.log(problems.length ? `FAIL: ${problems.join('；')}` : 'PASS: 手动关注/取关实时同步与快照提示正常');

fake.ws.close();
dash.ws.close();
for (const t of (await j('/json/list')).filter(
  (t) => t.type === 'page' && (t.url.startsWith('chrome-extension://') || t.url.startsWith('https://x.com'))
)) {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
}
process.exit(problems.length ? 1 : 0);
