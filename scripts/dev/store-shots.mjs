// 生成 Chrome Web Store 用的 1280x800 截图（演示数据，不含真实账号）。
// 运行前先按 scripts/dev/README.md 启动 Chrome for Testing。
import fs from 'node:fs';

const PORT = 9333;
const EXT_ID = 'lhjcbgklocfcaphoilhanbafgfmkaikl';
const OUT = new URL('../../docs/', import.meta.url).pathname;
const W = 1280;
const H = 800;

const j = async (p, m = 'GET') => (await (await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m })).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function demoData() {
  const account = {
    id: '44196397',
    screenName: 'tidyfollows_demo',
    name: '关注整理所 Demo',
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
      scanId: 'demo',
      stale: false,
      unfollowedAt: null,
    };
  });
  const protectedMap = {};
  [0, 4, 21].forEach((i) => {
    const id = String(9000000 + i);
    protectedMap[id] = { id, screenName: names[i][1], name: names[i][0], addedAt: Date.now() };
  });
  return {
    lanAccounts: [account],
    lanActive: account.id,
    [`lanRelations:${account.id}`]: relations,
    [`lanProtected:${account.id}`]: protectedMap,
    [`lanHistory:${account.id}`]: [
      { id: 'd1', type: 'detect', at: Date.now() - 3600000, stats: { mutual: 33, notFollowingBack: 18, notFollowedByMe: 9, total: 60 } },
      { id: 'u1', type: 'unfollow', at: Date.now() - 86400000, result: { ok: 12, failed: 0, protected: 2, total: 14 } },
      { id: 'd0', type: 'detect', at: Date.now() - 86400000 * 2, stats: { mutual: 30, notFollowingBack: 21, notFollowedByMe: 8, total: 59 } },
    ],
    lanSettings: {
      pageDelayMs: 1500, lookupDelayMs: 1500,
      unfollowMinDelayMs: 4000, unfollowMaxDelayMs: 8000, limitDefault: 1000,
    },
    lanCaptures: {
      updatedAt: Date.now() - 1800000,
      operations: {
        Following: { operation: 'Following', queryId: 'demo', at: Date.now() - 1800000 },
        Followers: { operation: 'Followers', queryId: 'demo', at: Date.now() - 1800000 },
      },
    },
  };
}

const target = await j('/json/new?about:blank', 'PUT');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, jj) => { ws.onopen = r; ws.onerror = jj; });
let id = 0;
const pend = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/src/ui/dashboard.html#/overview` });
await sleep(2500);

await ev(`chrome.storage.local.clear()`);
await ev(`chrome.storage.local.set(${JSON.stringify(demoData())})`);
await sleep(500);
await send('Page.reload');
await sleep(2000);

const shots = [
  ['overview', '#/overview'],
  ['relations', '#/relations?filter=notFollowingBack'],
  ['settings', '#/settings'],
];

for (const [name, hash] of shots) {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(800);
  const msg = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const data = msg.result?.data;
  if (!data) throw new Error('screenshot failed: ' + JSON.stringify(msg).slice(0, 300));
  fs.writeFileSync(`${OUT}preview-${name}.png`, Buffer.from(data, 'base64'));
  console.log('saved', `docs/preview-${name}.png`);
}

const problems = events.filter(
  (e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
);
console.log('problems:', problems.length ? problems : '(none)');

ws.close();
await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
process.exit(0);
