import fs from 'node:fs';

const EXT_ID = 'lhjcbgklocfcaphoilhanbafgfmkaikl';
const PORT = 9333;
const OUT = '/tmp/lanchrome-shots';
fs.mkdirSync(OUT, { recursive: true });

const httpJson = async (path, method = 'GET') => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text);
  }
};

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
  problems() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push(`EXCEPTION: ${d.exception?.description || d.text} @ ${d.url || ''}:${d.lineNumber || 0}`);
      }
      if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
        out.push(`CONSOLE ${e.params.type}: ` + e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
      if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
        out.push(`LOG ${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url || ''}`);
      }
    }
    return out;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(url, viewport = { width: 1440, height: 1000 }) {
  const target = await httpJson('/json/new?about:blank', 'PUT');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    if (cdp.events.some((e) => e.method === 'Page.loadEventFired')) break;
    await sleep(100);
  }
  await sleep(1200);
  return { cdp, target };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || '')
    );
  }
  return res.result.value;
}

async function shot(cdp, name, fullPage = false) {
  const params = { format: 'png', captureBeyondViewport: fullPage };
  if (fullPage) {
    const metrics = await cdp.send('Page.getLayoutMetrics');
    params.clip = {
      x: 0,
      y: 0,
      width: metrics.cssContentSize.width,
      height: metrics.cssContentSize.height,
      scale: 1,
    };
  }
  const { data } = await cdp.send('Page.captureScreenshot', params);
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  console.log('shot', name);
}

function demoData() {
  const account = {
    id: '44196397',
    screenName: 'iiiwuxxx',
    name: 'Leo',
    avatar: null,
    connectedAt: Date.now() - 86400000 * 3,
    lastDetectAt: Date.now() - 3600000,
  };
  const names = [
    ['林晚照', 'linwanzhao'], ['Kaito', 'kaito_dev'], ['Mira Chen', 'mirachendev'],
    ['陈以宁', 'yining_chan'], ['Alex Rivera', 'alexrivera'], ['小岛来信', 'islandletter'],
    ['Nora', 'nora_writes'], ['周牧', 'zhoumu'], ['Sam Lee', 'samlee_ux'],
    ['苏打气泡', 'sodapop_'], ['Ethan Park', 'ethanpark'], ['陆青', 'luqing'],
    ['Ivy', 'ivybuilds'], ['顾南', 'gunan'], ['Theo', 'theo_makes'],
    ['夏然', 'xiaran'], ['Momo', 'momo_daily'], ['宋屿', 'songyu'],
    ['Ren', 'ren_codes'], ['白鹿', 'bailu_'], ['Kira', 'kira_notes'],
    ['程野', 'chengye'], ['Luca', 'luca_ai'], ['沈知微', 'zhiwei_shen'],
    ['June', 'june_park'], ['许星河', 'xinghe'], ['Noah', 'noahbuilds'],
    ['安然', 'anran'], ['Yuki', 'yuki_design'], ['江屿', 'jiangyu'],
    ['Mia', 'mia_labs'], ['季白', 'jibai'], ['Owen', 'owen_lee'],
    ['温言', 'wenyan'], ['Rin', 'rin_tsuk'], ['秦朗', 'qinlang'],
    ['Ada', 'ada_w'], ['叶知秋', 'zhiqiu_ye'], ['Ben', 'ben_tries'],
    ['洛洛', 'luoluo'], ['Chloe', 'chloe_codes'], ['何川', 'hechuan'],
    ['Ari', 'ari_dev'], ['南枝', 'nanzhi'], ['Eli', 'eli_works'],
    ['唐棠', 'tangtang_'], ['Zoe', 'zoe_builds'], ['简宁', 'jianning'],
    ['Max', 'max_ops'], ['余温', 'yuwen'], ['Nina', 'nina_draws'],
    ['宋词', 'songci'], ['Leo K', 'leok_'], ['晚风', 'wanfeng'],
    ['Iris', 'iris_pm'], ['林深', 'linshen'], ['Hugo', 'hugo_dev'],
    ['夏夏', 'xiaxia_'], ['Rae', 'rae_writes'], ['陈默', 'chenmo'],
  ];
  const relations = {};
  names.forEach(([name, handle], i) => {
    const id = String(9000000 + i);
    let following, followsMe;
    if (i < 18) { following = true; followsMe = false; }
    else if (i < 27) { following = false; followsMe = true; }
    else { following = true; followsMe = true; }
    relations[id] = {
      id, screenName: handle, name, avatar: null, following, followsMe,
      protected: [0, 4, 21].includes(i),
      firstSeen: Date.now() - 86400000 * 20,
      lastSeen: Date.now() - i * 60000,
      scannedAt: Date.now() - 3600000,
      unfollowedAt: null,
    };
  });
  const protectedMap = {
    '9000000': { id: '9000000', screenName: 'linwanzhao', name: '林晚照', addedAt: Date.now() - 86400000 },
    '9000004': { id: '9000004', screenName: 'alexrivera', name: 'Alex Rivera', addedAt: Date.now() },
    '9000021': { id: '9000021', screenName: 'kira_notes', name: 'Kira', addedAt: Date.now() },
    'sn:brandnew': { screenName: 'brandnew', name: 'brandnew', addedAt: Date.now(), manual: true },
  };
  const history = [
    { id: 'd1', type: 'detect', at: Date.now() - 3600000, stats: { mutual: 33, notFollowingBack: 18, notFollowedByMe: 9, total: 60 } },
    { id: 'u1', type: 'unfollow', at: Date.now() - 86400000, result: { ok: 12, failed: 0, protected: 2, total: 14 } },
    { id: 'd0', type: 'detect', at: Date.now() - 86400000 * 2, stats: { mutual: 30, notFollowingBack: 21, notFollowedByMe: 8, total: 59 } },
  ];
  return {
    lanAccounts: [account],
    lanActive: account.id,
    [`lanRelations:${account.id}`]: relations,
    [`lanProtected:${account.id}`]: protectedMap,
    [`lanHistory:${account.id}`]: history,
    lanSettings: {
      pageDelayMs: 1500, lookupDelayMs: 1500,
      unfollowMinDelayMs: 4000, unfollowMaxDelayMs: 8000, limitDefault: 1000,
    },
    lanCaptures: {
      updatedAt: Date.now() - 1800000,
      operations: {
        Following: { operation: 'Following', queryId: 'demo', features: null, variables: null, at: Date.now() - 1800000 },
        Followers: { operation: 'Followers', queryId: 'demo', features: null, variables: null, at: Date.now() - 1800000 },
      },
    },
    lanWarmups: { 123: { op: 'Following', at: Date.now(), url: 'https://x.com/demo/following' } },
    lanWorkerTab: { tabId: 123, at: Date.now() },
  };
}

const results = {};

async function main() {
  /* ---------- dashboard ---------- */
  const url = `chrome-extension://${EXT_ID}/src/ui/dashboard.html#/overview`;
  const { cdp } = await openPage(url);

  results.version = await evaluate(cdp, `chrome.runtime.getManifest().version`);
  results.manifestName = await evaluate(cdp, `chrome.runtime.getManifest().name`);

  const data = demoData();
  await evaluate(cdp, `chrome.storage.local.set(${JSON.stringify(data)})`);
  await sleep(500);
  await cdp.send('Page.reload');
  await sleep(1800);
  await shot(cdp, '01-overview', true);

  results.removedCard = await evaluate(cdp, `({
    cardPage: !!document.querySelector('[data-page="card"]'),
    canvas: !!document.querySelector('#cardCanvas'),
    navCard: !!document.querySelector('#nav a[data-route="card"]'),
    titlesCard: typeof PAGE_TITLES !== 'undefined' ? Object.prototype.hasOwnProperty.call(PAGE_TITLES, 'card') : null
  })`);

  results.routes = {};
  for (const route of ['overview', 'relations', 'protect', 'backup', 'settings']) {
    await evaluate(cdp, `location.hash = '#/${route}'`);
    await sleep(600);
    results.routes[route] = await evaluate(cdp, `({
      active: document.querySelector('.page.active')?.dataset.page || null,
      title: document.querySelector('#pageTitle')?.textContent || '',
      visibleText: (document.querySelector('.page.active')?.innerText || '').slice(0, 120)
    })`);
    if (route === 'relations' || route === 'settings' || route === 'backup') {
      await shot(cdp, `02-${route}`, true);
    }
  }

  // 关系页：统计、行数、勾选
  await evaluate(cdp, `location.hash = '#/relations?filter=notFollowingBack'`);
  await sleep(600);
  results.relations = await evaluate(cdp, `(() => {
    const rows = [...document.querySelectorAll('.rel-row')];
    const before = document.querySelector('#selectedCount')?.textContent || '';
    let clicked = 0;
    for (const r of rows.slice(0, 3)) {
      const c = r.querySelector('.rel-check');
      if (c && !c.classList.contains('disabled')) { r.click(); clicked++; }
    }
    return {
      rows: rows.length,
      stats: {
        mutual: document.querySelector('[data-stat="mutual"]')?.textContent,
        notFollowingBack: document.querySelector('[data-stat="notFollowingBack"]')?.textContent,
        notFollowedByMe: document.querySelector('[data-stat="notFollowedByMe"]')?.textContent,
        protected: document.querySelector('[data-stat="protected"]')?.textContent
      },
      before, after: document.querySelector('#selectedCount')?.textContent || '',
      clicked
    };
  })()`);
  await sleep(400);
  await shot(cdp, '03-relations-selected', true);

  // 关于页：隐私/支持链接
  results.aboutLinks = await evaluate(cdp, `[...document.querySelectorAll('[data-page="settings"] a[href^="https://tidyfollows"]')].map(a => a.href)`);

  /* ---------- 备份导出（不落盘，拦截下载） ---------- */
  await evaluate(cdp, `location.hash = '#/backup'`);
  await sleep(400);
  const exported = await evaluate(cdp, `(async () => {
    let captured = null;
    const origCreate = URL.createObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { captured = b; return 'blob:blocked'; };
    HTMLAnchorElement.prototype.click = function () {};
    document.querySelector('#exportBtn').click();
    await new Promise(r => setTimeout(r, 500));
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
    if (!captured) return { error: 'no blob captured' };
    const text = await captured.text();
    return { text, size: text.length };
  })()`);
  if (exported?.text) {
    const payload = JSON.parse(exported.text);
    results.backup = {
      size: exported.size,
      app: payload.app,
      schema: payload.schema,
      version: payload.version,
      hasCaptures: Object.prototype.hasOwnProperty.call(payload.data, 'lanCaptures'),
      hasWarmups: Object.prototype.hasOwnProperty.call(payload.data, 'lanWarmups'),
      hasWorkerTab: Object.prototype.hasOwnProperty.call(payload.data, 'lanWorkerTab'),
      hasTask: Object.prototype.hasOwnProperty.call(payload.data, 'lanTask'),
      keys: Object.keys(payload.data).sort(),
      relationsCount: Object.keys(payload.data['lanRelations:44196397'] || {}).length
    };
  } else {
    results.backup = exported;
  }

  /* ---------- 存储清理按钮 ---------- */
  results.clearCapsButton = await evaluate(cdp, `(() => {
    const b = document.querySelector('#clearCaps');
    return b ? b.textContent.trim() : null;
  })()`);

  /* ---------- popup ---------- */
  const popup = await openPage(`chrome-extension://${EXT_ID}/src/ui/popup.html`, {
    width: 372,
    height: 620,
  });
  await sleep(800);
  await shot(popup.cdp, '04-popup', true);
  results.popup = await evaluate(popup.cdp, `({
    title: document.title,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 240),
    buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim())
  })`);

  /* ---------- service worker ---------- */
  const targets = await httpJson('/json/list');
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  results.serviceWorker = sw
    ? await (async () => {
        const c = new CDP(sw.webSocketDebuggerUrl);
        await c.connect();
        await c.send('Runtime.enable');
        const out = await evaluate(c, `({ version: chrome.runtime.getManifest().version, hasAlarmApi: !!chrome.alarms })`);
        c.close();
        return out;
      })()
    : 'not found';

  results.dashboardProblems = cdp.problems();
  results.popupProblems = popup.cdp.problems();

  // 清理演示数据，避免影响后续真实使用
  await evaluate(cdp, `chrome.storage.local.clear()`);

  cdp.close();
  popup.cdp.close();

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('FAILED', err);
  process.exit(1);
});
