/**
 * 关注整理所 — 隔离世界 Content Script
 * 运行在 x.com 页面中，负责：
 *  - 与 MAIN world 的页面代理通信（实际请求由页面上下文发出）
 *  - 连接账号、分页读取关注/粉丝名单、互关核对
 *  - 批量取关、断点续跑、进度落盘
 */
(() => {
  'use strict';
  if (window.__LAN_BLUE_BRIDGE__) return;
  window.__LAN_BLUE_BRIDGE__ = true;

  const NS = 'LAN_BLUE';
  const X_ORIGIN = 'https://x.com';
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

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base, spread = 250) => base + Math.floor(Math.random() * spread);

  function storageGet(key, fallback) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (out) => {
        resolve(out && out[key] !== undefined ? out[key] : fallback);
      });
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  async function getSettings() {
    const stored = (await storageGet('lanSettings', {})) || {};
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      // 时间间隔固定，避免旧设置或导入备份用回过快的节奏
      ...FIXED_INTERVALS,
      limitDefault:
        Number(stored.limitDefault) > 0
          ? Number(stored.limitDefault)
          : DEFAULT_SETTINGS.limitDefault,
    };
  }

  function isProtected(protectedMap, id, screenName) {
    if (!protectedMap) return false;
    if (id && protectedMap[id]) return true;
    if (screenName && protectedMap[String(screenName).toLowerCase()]) return true;
    return false;
  }

  class CancelledError extends Error {
    constructor() {
      super('任务已停止');
      this.name = 'Cancelled';
    }
  }

  /* ------------------------------------------------------------------ */
  /* 与页面代理通信                                                      */
  /* ------------------------------------------------------------------ */

  const pendingCalls = new Map();
  let callSeq = 0;
  let agentReady = false;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__lan !== NS) return;

    if (data.dir === 'res' && pendingCalls.has(data.id)) {
      const { resolve, reject, timer } = pendingCalls.get(data.id);
      clearTimeout(timer);
      pendingCalls.delete(data.id);
      if (data.ok) resolve(data);
      else reject(new Error(data.error || '页面代理返回错误'));
      return;
    }

    if (data.dir === 'event') {
      if (data.event === 'ready') agentReady = true;
      // 采集窗口里的翻页请求只在本页解析，不写回全局参数缓存，
      // 否则最后一页的响应会被当成下次检测的第一页。
      if (!harvest) {
        if (data.event === 'capture' && data.data) {
          try {
            chrome.runtime.sendMessage({ type: 'lan:capture', operation: data.data });
          } catch (_) {}
        }
        if (data.event === 'captureResult' && data.data) {
          try {
            chrome.runtime.sendMessage({ type: 'lan:capture-result', result: data.data });
          } catch (_) {}
        }
        if (data.event === 'captureBody' && data.data) {
          try {
            chrome.runtime.sendMessage({ type: 'lan:capture-body', body: data.data });
          } catch (_) {}
        }
      }
      if (data.event === 'captureBody' && data.data) handleHarvestBody(data.data);
    }
  });

  function agentCall(cmd, payload, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = 'c' + ++callSeq;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error('页面代理响应超时'));
      }, timeoutMs);
      pendingCalls.set(id, { resolve, reject, timer });
      window.postMessage({ __lan: NS, dir: 'req', id, cmd, payload }, location.origin);
    });
  }

  async function ensureAgent() {
    if (agentReady) return;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await agentCall('ping', null, 3000);
        if (res.ok) {
          agentReady = true;
          return;
        }
      } catch (_) {}
      await wait(350);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 粉丝页翻页采集                                                       */
  /* ------------------------------------------------------------------ */

  /* X 会校验 Followers 接口的 x-client-transaction-id，重放后续页会 404。
     这里换一种做法：在后台窗口里打开真实的粉丝页，滚动让它自己发出后续页请求，
     再把网页端自己返回的每一页响应解析合并。 */
  // 全量名单可能很长。滚动页本身负责限流，给单页网络响应留出足够时间，
  // 避免刚打开页面或 X 响应稍慢时就被误判为「已经到底」。
  const HARVEST_MAX_MS = 30 * 60 * 1000;
  const HARVEST_SCROLL_WAIT_MS = 1500;
  const HARVEST_IDLE_LIMIT = 20;

  let harvest = null;

  function harvestMerge(parsed) {
    if (!harvest || !parsed) return 0;
    // 200 也可能是错误 JSON 或登录页，不能把空响应当成「已到末尾」
    if (!(parsed.users && parsed.users.length) && !parsed.cursor && !parsed.terminated) return 0;
    let added = 0;
    for (const u of parsed.users || []) {
      if (u && u.id && !harvest.seen.has(u.id)) {
        harvest.seen.add(u.id);
        harvest.users.push(u);
        added += 1;
      }
    }
    harvest.pages += 1;
    if (added) harvest.lastNewAt = Date.now();
    // 只有明确的 TimelineTerminateTimeline 才算「确认读完」。
    // 某些响应可能暂时缺少 cursor，直接把它当成末尾会让全量检测静默截断。
    if (parsed.terminated) {
      harvest.exhausted = true;
    } else {
      harvest.cursor = parsed.cursor || harvest.cursor;
    }
    return added;
  }

  function mergeHarvestBody(body) {
    if (!harvest || harvest.done) return;
    if (!body || body.operation !== 'Followers' || !body.text) return;
    if (body.requestId && harvest.seenResponses.has(body.requestId)) return;
    try {
      harvestMerge(parseTimeline(JSON.parse(body.text)));
      if (body.requestId) harvest.seenResponses.add(body.requestId);
    } catch (_) {}
  }

  function handleHarvestBody(body) {
    mergeHarvestBody(body);
  }

  function scrollHarvestPage() {
    try {
      const se = document.scrollingElement || document.documentElement;
      const height = (se && se.scrollHeight) || 0;
      window.scrollTo(0, Math.max(0, height));
      // 部分布局把滚动放在主栏内部，一并滚到底
      const main = document.querySelector('[data-testid="primaryColumn"]');
      for (let el = main; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 200) el.scrollTop = el.scrollHeight;
      }
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
    } catch (_) {}
  }

  async function publishHarvest(done = false) {
    if (!harvest) return;
    const data = {
      taskId: harvest.taskId,
      op: 'Followers',
      count: harvest.users.length,
      pages: harvest.pages,
      exhausted: harvest.exhausted,
      timedOut: harvest.timedOut,
      cancelled: harvest.cancelled,
      done,
      at: Date.now(),
    };
    if (done) data.users = harvest.users;
    await storageSet({ [`lanHarvest:${harvest.taskId}`]: data });
  }

  async function runHarvestLoop() {
    const current = harvest;
    if (!current) return;
    let idle = 0;
    let publishedPages = current.pages;
    while (harvest === current && !current.done) {
      if (current.cancelled) break;
      if (current.limit && current.users.length >= current.limit) {
        current.capped = true;
        break;
      }
      if (current.exhausted) break;
      if (Date.now() - current.startedAt > HARVEST_MAX_MS) {
        current.timedOut = true;
        break;
      }

      const pagesBefore = current.pages;
      scrollHarvestPage();
      await wait(HARVEST_SCROLL_WAIT_MS);

      if (current.pages === pagesBefore) idle += 1;
      else idle = 0;
      if (current.pages !== publishedPages) {
        publishedPages = current.pages;
        await publishHarvest(false).catch(() => {});
      }
      if (idle >= HARVEST_IDLE_LIMIT) break;
    }

    current.done = true;
    await publishHarvest(true);
    try {
      chrome.runtime.sendMessage({
        type: 'lan:harvest-done',
        taskId: current.taskId,
        count: current.users.length,
      });
    } catch (_) {}
    if (harvest === current) harvest = null;
  }

  async function startHarvest(payload = {}) {
    if (harvest && !harvest.done) return { ok: false, error: '已有粉丝翻页任务在运行' };
    const taskId = payload.taskId;
    if (!taskId) return { ok: false, error: '缺少任务 ID' };

    harvest = {
      taskId,
      limit: Number(payload.limit) > 0 ? Number(payload.limit) : null,
      users: [],
      seen: new Set(),
      seenResponses: new Set(),
      pages: 0,
      cursor: null,
      exhausted: false,
      capped: false,
      timedOut: false,
      cancelled: false,
      done: false,
      startedAt: Date.now(),
      lastNewAt: Date.now(),
    };

    // 命令到达前网页端可能已经拿到了第一页，先把它并进来。
    // 只接受本次打开粉丝页之后捕获的响应，避免把上次检测的最后一页当成第一页。
    const readFirstBody = async () => {
      try {
        const caps = await readCaptures();
        const info = caps && caps.operations && caps.operations.Followers;
        if (!info || !info.lastBody) return false;
        if (!info.lastBodyAt || info.lastBodyAt < harvest.startedAt - 3000) return false;
        harvestMerge(parseTimeline(JSON.parse(info.lastBody)));
        if (info.lastBodyRequestId) harvest.seenResponses.add(info.lastBodyRequestId);
        return true;
      } catch (_) {
        return false;
      }
    };

    await readFirstBody();
    for (let i = 0; i < 10 && !harvest.pages; i++) {
      await wait(500);
      await readFirstBody();
    }

    await publishHarvest(false);
    runHarvestLoop().catch(async () => {
      if (!harvest) return;
      harvest.done = true;
      harvest.timedOut = true;
      await publishHarvest(true).catch(() => {});
      harvest = null;
    });
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* 任务落盘                                                            */
  /* ------------------------------------------------------------------ */

  let saveTimer = null;
  let lastSaveAt = 0;

  function saveTask(task, immediate = false) {
    task.updatedAt = Date.now();
    if (immediate) {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      lastSaveAt = Date.now();
      chrome.storage.local.set({ lanTask: task });
      return;
    }
    if (saveTimer) return;
    const delayMs = Math.max(0, 900 - (Date.now() - lastSaveAt));
    saveTimer = setTimeout(() => {
      saveTimer = null;
      lastSaveAt = Date.now();
      chrome.storage.local.set({ lanTask: task });
    }, delayMs);
  }

  function setProgress(task, phase, message, extra = {}) {
    task.progress = {
      ...(task.progress || {}),
      phase,
      message,
      ...extra,
    };
    saveTask(task);
  }

  /* ------------------------------------------------------------------ */
  /* 接口封装                                                            */
  /* ------------------------------------------------------------------ */

  async function api(payload) {
    await ensureAgent();
    const res = await agentCall('api', payload, payload.timeoutMs || 60000);
    return res.response;
  }

  function headersNumber(headers, name) {
    const v = headers && headers[name];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function waitForRateLimit(task, headers, label) {
    const reset = headersNumber(headers, 'x-rate-limit-reset');
    const now = Date.now();
    let ms = reset ? reset * 1000 - now : 60000;
    if (!Number.isFinite(ms) || ms < 3000) ms = 60000;
    ms = Math.min(ms, 15 * 60 * 1000) + 2000;
    const until = Date.now() + ms;
    setProgress(task, label, `触发 X 限流，等待 ${Math.ceil(ms / 1000)} 秒后继续…`);
    while (Date.now() < until) {
      if (cancelRequested) throw new CancelledError();
      const left = Math.min(20000, until - Date.now());
      await wait(Math.max(0, left));
      task.updatedAt = Date.now();
      saveTask(task);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 接口参数（queryId / features）准备                                   */
  /* ------------------------------------------------------------------ */

  function hasTemplates(caps, ops = ['Following', 'Followers']) {
    if (!caps || !caps.operations) return false;
    return ops.every((op) => caps.operations[op] && caps.operations[op].queryId);
  }

  function capturesFresh(caps, ops = ['Following', 'Followers']) {
    if (!caps || !caps.operations) return false;
    const cutoff = Date.now() - 18 * 60 * 60 * 1000;
    return ops.every((op) => caps.operations[op] && (caps.operations[op].at || 0) >= cutoff);
  }

  function opsFreshSince(caps, ops, since) {
    if (!caps || !caps.operations) return false;
    return ops.every((op) => caps.operations[op] && (caps.operations[op].at || 0) >= since);
  }

  async function readCaptures() {
    return storageGet('lanCaptures', null);
  }

  // 只刷新参数，不写入任务状态
  async function refreshCapturesQuiet(account) {
    const startedAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'lan:warmup', account, force: true });
    } catch (_) {}
    while (Date.now() - startedAt < 45000) {
      await wait(800);
      const caps = await readCaptures();
      if (hasTemplates(caps) && opsFreshSince(caps, ['Following', 'Followers'], startedAt - 1000)) {
        return caps;
      }
    }
    return null;
  }

  async function ensureTemplates(task, { force = false } = {}) {
    let caps = await readCaptures();
    if (!force && hasTemplates(caps) && capturesFresh(caps)) return caps;

    setProgress(task, '准备', '正在从 X 获取接口参数（会短暂打开后台页面）…');
    try {
      chrome.runtime.sendMessage({
        type: 'lan:warmup',
        account: task.account,
        force,
      });
    } catch (_) {}

    const startedAt = Date.now();
    const deadline = startedAt + 45000;
    const required = ['Following', 'Followers'];
    while (Date.now() < deadline) {
      if (cancelRequested) throw new CancelledError();
      await wait(800);
      caps = await readCaptures();
      // 必须两个接口都是本次新捕获的，避免混用旧 queryId
      if (hasTemplates(caps) && opsFreshSince(caps, required, startedAt - 1000)) return caps;
      const missing = required.filter(
        (op) => !caps || !caps.operations || !caps.operations[op] || (caps.operations[op].at || 0) < startedAt - 1000
      );
      setProgress(task, '准备', `正在等待 ${missing.join(' / ')} 接口参数…`);
      task.updatedAt = Date.now();
      saveTask(task);
    }
    // 超时后退回到已有的缓存，尽量让任务跑起来
    const stale = await readCaptures();
    if (hasTemplates(stale)) {
      setProgress(task, '准备', '未能刷新完整接口参数，使用上次缓存继续…');
      return stale;
    }
    throw new Error('未能获取 X 接口参数。请打开一次 x.com 的「正在关注」页面后重试。');
  }

  function buildListUrl(caps, op, { userId, cursor, count }) {
    const info = caps.operations[op];
    if (!info || !info.queryId) throw new Error(`缺少 ${op} 接口参数`);
    // 第一页优先使用预热时没有 cursor 的那次请求变量，保持原始字段组合
    const source = !cursor && info.firstVariables ? info.firstVariables : info.variables;
    let vars;
    try {
      vars = source ? JSON.parse(source) : {};
    } catch (_) {
      vars = {};
    }
    vars.userId = String(userId);
    if (!vars.count) vars.count = count || 20;
    if (cursor) vars.cursor = cursor;
    else if (!info.firstVariables) delete vars.cursor;

    const params = new URLSearchParams();
    params.set('variables', JSON.stringify(vars));
    if (info.features) params.set('features', info.features);
    if (info.fieldToggles) params.set('fieldToggles', info.fieldToggles);
    return `${X_ORIGIN}/i/api/graphql/${info.queryId}/${op}?${params.toString()}`;
  }

  /* ------------------------------------------------------------------ */
  /* 响应解析                                                            */
  /* ------------------------------------------------------------------ */

  function normalizeUser(result) {
    if (!result || !result.rest_id) return null;
    const core = result.core || {};
    const legacy = result.legacy || {};
    const avatar =
      (result.avatar && result.avatar.image_url) ||
      legacy.profile_image_url_https ||
      null;
    return {
      id: String(result.rest_id),
      screenName: core.screen_name || legacy.screen_name || '',
      name: core.name || legacy.name || '',
      avatar: avatar ? avatar.replace('_normal.', '_200x200.') : null,
      verified: !!(result.is_blue_verified || legacy.verified),
    };
  }

  function parseTimeline(json) {
    const out = { users: [], cursor: null };
    const result = json && json.data && json.data.user && json.data.user.result;
    if (!result) return out;

    const timelines = [];
    if (result.timeline) {
      if (result.timeline.timeline) timelines.push(result.timeline.timeline);
      if (Array.isArray(result.timeline.instructions)) timelines.push(result.timeline);
    }
    if (result.timeline_v2 && result.timeline_v2.timeline) timelines.push(result.timeline_v2.timeline);

    const seen = new Set();
    const addUser = (u) => {
      if (u && u.id && !seen.has(u.id)) {
        seen.add(u.id);
        out.users.push(u);
      }
    };

    const handleEntry = (entry) => {
      if (!entry) return;
      const entryId = entry.entryId || '';
      const content = entry.content || {};

      if (entryId.startsWith('cursor-bottom')) {
        if (content.value) out.cursor = content.value;
      } else if (entryId.startsWith('cursor-top')) {
        // ignore
      } else if (content.itemContent) {
        addUser(normalizeUser(content.itemContent.user_results && content.itemContent.user_results.result));
      } else if (Array.isArray(content.items)) {
        for (const item of content.items) {
          const inner = item && item.item;
          const r = inner && inner.itemContent && inner.itemContent.user_results && inner.itemContent.user_results.result;
          addUser(normalizeUser(r));
        }
      }
    };

    for (const timeline of timelines) {
      const instructions = timeline.instructions || [];
      for (const ins of instructions) {
        if (Array.isArray(ins.entries)) ins.entries.forEach(handleEntry);
        if (ins.entry) handleEntry(ins.entry);
        if (ins.type === 'TimelineReplaceEntry' && ins.entryId && ins.entryId.startsWith('cursor-bottom')) {
          const v = ins.entry && ins.entry.content && ins.entry.content.value;
          if (v) out.cursor = v;
        }
        // Top 只表示上方没有更新内容，不代表向下分页已经到底。
        if (
          ins.type === 'TimelineTerminateTimeline' &&
          String(ins.direction || '').toLowerCase() !== 'top'
        ) {
          out.terminated = true;
        }
        if (Array.isArray(ins.moduleItems)) {
          for (const mi of ins.moduleItems) {
            const r = mi && mi.item && mi.item.itemContent && mi.item.itemContent.user_results && mi.item.itemContent.user_results.result;
            addUser(normalizeUser(r));
          }
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 名单抓取                                                            */
  /* ------------------------------------------------------------------ */

  async function requestList(task, capsRef, op, cursor) {
    const settings = await getSettings();
    for (let attempt = 0; attempt < 6; attempt++) {
      if (cancelRequested) throw new CancelledError();
      const caps = capsRef.caps;
      const url = buildListUrl(caps, op, {
        userId: task.account.id,
        cursor,
        count: 20,
      });
      const info = caps.operations[op];
      const res = await api({
        method: 'GET',
        url,
        useTransaction: true,
        transactionId: info.transactionId || null,
        headers: info.headers || {},
      });

      if (res.status === 200) {
        try {
          return JSON.parse(res.text);
        } catch (_) {
          throw new Error('X 返回的数据无法解析，请稍后重试');
        }
      }
      if (res.status === 401) {
        throw new Error('登录状态已失效，请先在 x.com 重新登录');
      }
      if (res.status === 429) {
        // 粉丝后续页本来就要交给页面自己加载，不必在这里长时间等待限流
        if (op === 'Followers' && cursor) throw new Error('粉丝后续页触发限流');
        await waitForRateLimit(task, res.headers, `${op}`);
        continue;
      }
      if (res.status === 404 || res.status === 400 || res.status === 403) {
        // 粉丝名单的后续页由 X 的页面自己滚动加载，重放失败时不必再刷新参数
        if (op === 'Followers' && cursor) {
          throw new Error('粉丝后续页需要网页端加载');
        }
        if (attempt < 2) {
          setProgress(task, '准备', '接口参数已过期，正在刷新…');
          capsRef.caps = await ensureTemplates(task, { force: true });
          continue;
        }
        throw new Error(
          `${op} 接口返回 ${res.status}。可能是 X 接口已更新、登录状态异常或访问受限，请刷新接口参数后重试。`
        );
      }
      if (res.status >= 500) {
        await wait(jitter(1500, 1500));
        continue;
      }
      throw new Error(`${op} 请求失败：HTTP ${res.status}`);
    }
    throw new Error(`${op} 请求多次失败，请稍后重试`);
  }

  async function collectList(task, capsRef, op) {
    const key = op === 'Following' ? 'following' : 'followers';
    const label = op === 'Following' ? '正在关注' : '关注我的人';
    const bucket =
      task.state[key] || (task.state[key] = { users: [], cursor: null, complete: false, pages: 0 });
    const seen = new Set(bucket.users.map((u) => u.id));
    const settings = await getSettings();
    const limit = task.params.limit || null;

    if (bucket.complete) return bucket;

    // 优先使用暖身时网页端自己返回的第一页（tx 无法重放，但响应可以直接用）
    if (!bucket.users.length && !bucket.cursor) {
      let info = capsRef.caps.operations[op];
      // 响应体可能比请求捕获晚几百毫秒到达，短暂等它一下
      if (op === 'Followers' && (!info || !info.lastBody)) {
        for (let i = 0; i < 10; i++) {
          await wait(500);
          const fresh = await readCaptures();
          const next = fresh && fresh.operations && fresh.operations[op];
          if (next && next.lastBody) {
            capsRef.caps = fresh;
            info = next;
            break;
          }
        }
      }
      const body = info && info.lastBody;
      const sameRequest = !info || !info.lastBodyRequestId || !info.requestId || info.lastBodyRequestId === info.requestId;
      let bodyHasCursor = false;
      try {
        bodyHasCursor = !!(info && info.variables && JSON.parse(info.variables).cursor);
      } catch (_) {}
      if (body && sameRequest && !bodyHasCursor) {
        try {
          const parsed = parseTimeline(JSON.parse(body));
          if (parsed && (parsed.users.length || parsed.terminated || parsed.cursor)) {
            for (const u of parsed.users) {
              if (u.id && !seen.has(u.id)) {
                seen.add(u.id);
                bucket.users.push(u);
              }
            }
            bucket.pages = 1;
            bucket.cursor = parsed.cursor || null;
            bucket.fromBody = true;
            if (!parsed.cursor || parsed.users.length === 0 || parsed.terminated) {
              bucket.complete = true;
            }
            setProgress(task, label, `${label}：使用网页端响应，共 ${bucket.users.length} 人`, {
              done: bucket.users.length,
              total: limit || null,
            });
            saveTask(task);
          }
        } catch (_) {}
      }
    }

    while (!bucket.complete) {
      if (cancelRequested) throw new CancelledError();
      if (limit && bucket.users.length >= limit) {
        bucket.capped = true;
        break;
      }

      let json;
      try {
        json = await requestList(task, capsRef, op, bucket.cursor);
      } catch (err) {
        // 粉丝名单只拿到一部分时不要丢弃已有数据，标记为部分可用
        if (op === 'Followers' && bucket.users.length > 0 && !(err instanceof CancelledError)) {
          bucket.complete = true;
          bucket.partial = true;
          bucket.error = err && err.message ? err.message : String(err);
          task.approximate = true;
          setProgress(
            task,
            label,
            `${label}：只读取到前 ${bucket.users.length} 人（接口限制），继续检测…`
          );
          saveTask(task, true);
          break;
        }
        throw err;
      }
      const parsed = parseTimeline(json);
      const previousCursor = bucket.cursor;
      for (const u of parsed.users) {
        if (!seen.has(u.id)) {
          seen.add(u.id);
          bucket.users.push(u);
        }
      }
      bucket.pages = (bucket.pages || 0) + 1;

      const next = parsed.cursor;
      if (parsed.terminated || !next) {
        bucket.complete = true;
      } else if (next === previousCursor) {
        // 游标没有前进时继续请求只会死循环；保留已读数据并明确标为部分结果。
        bucket.complete = true;
        bucket.partial = true;
        bucket.error = '分页游标未前进，名单可能不完整';
      } else {
        // 某一页可能只有重复用户，但游标仍会前进；不能据此提前结束全量检测。
        bucket.cursor = next;
      }

      setProgress(task, label, `${label}：已读取 ${bucket.users.length} 人`, {
        done: bucket.users.length,
        total: limit || null,
      });
      saveTask(task);

      if (!bucket.complete) await wait(jitter(settings.pageDelayMs, 350));
    }

    setProgress(
      task,
      label,
      bucket.capped
        ? `${label}：达到 ${limit} 人上限`
        : bucket.partial
        ? `${label}：只读取到前 ${bucket.users.length} 人（接口限制）`
        : `${label}：读取完成，共 ${bucket.users.length} 人${bucket.fromBody ? '（网页端响应）' : ''}`
    );
    saveTask(task, true);
    return bucket;
  }

  // 让后台窗口里的真实粉丝页自己翻页，返回网页端捕获到的完整名单
  async function harvestFollowers(task, bucket) {
    const target = task.params.limit || null;
    const limit = target ? Math.max(0, target - bucket.users.length) : null;
    if (target && limit === 0) return { skipped: true, users: [] };
    const key = `lanHarvest:${task.id}`;
    try {
      chrome.storage.local.remove(key);
    } catch (_) {}

    setProgress(task, '关注我的人', '正在通过页面读取粉丝后续页面（会短暂打开一个后台窗口）…', {
      done: bucket.users.length,
      total: target || null,
    });
    saveTask(task);

    let stopped = false;
    const stopHarvest = () => {
      if (stopped) return;
      stopped = true;
      try {
        chrome.runtime.sendMessage({ type: 'lan:harvest-stop', taskId: task.id });
      } catch (_) {}
    };

    let started;
    try {
      started = await Promise.race([
        new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'lan:harvest-followers', account: task.account, taskId: task.id, limit },
            (res) => resolve(res)
          );
        }),
        wait(75000).then(() => ({ ok: false, error: '打开粉丝页面超时' })),
      ]);
    } catch (err) {
      stopHarvest();
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!started || !started.ok) {
      stopHarvest();
      return { error: (started && started.error) || '无法打开粉丝页面' };
    }

    const deadline = Date.now() + HARVEST_MAX_MS;
    let lastCount = -1;
    let final = null;
    try {
      while (Date.now() < deadline) {
        if (cancelRequested) throw new CancelledError();
        const data = await storageGet(key, null);
        if (data && data.count !== lastCount) {
          lastCount = data.count;
          setProgress(
            task,
            '关注我的人',
            `关注我的人：正在读取后续页面（后续页已读 ${data.count} 人）`,
            { done: bucket.users.length + data.count, total: target || null }
          );
          saveTask(task);
        }
        if (data && data.done) {
          final = data;
          break;
        }
        // 采集可能持续较久，保持任务心跳，避免被后台判定为无响应
        task.updatedAt = Date.now();
        saveTask(task);
        await wait(1200);
      }
    } catch (err) {
      stopHarvest();
      throw err;
    }

    if (!final) {
      stopHarvest();
      final = await storageGet(key, null);
    }
    try {
      chrome.storage.local.remove(key);
    } catch (_) {}
    return final || { error: '读取粉丝后续页面超时' };
  }

  function mergeHarvest(task, bucket, result) {
    if (!result || !Array.isArray(result.users)) return false;
    const seen = new Set(bucket.users.map((u) => u.id));
    for (const u of result.users) {
      if (u && u.id && !seen.has(u.id)) {
        seen.add(u.id);
        bucket.users.push(u);
      }
    }
    bucket.pages = (bucket.pages || 0) + (result.pages || 0);
    if (bucket.users.length > 0) {
      bucket.unavailable = false;
      bucket.error = null;
    }
    const limit = task.params.limit || null;
    if (limit && bucket.users.length >= limit) {
      bucket.capped = true;
      bucket.complete = true;
      bucket.partial = false;
      return true;
    }
    if (result.exhausted) {
      bucket.complete = true;
      bucket.partial = false;
      bucket.unavailable = false;
      bucket.error = null;
      return true;
    }
    bucket.complete = true;
    bucket.partial = true;
    bucket.harvestError =
      result.error || (result.timedOut ? '粉丝页加载超时' : result.cancelled ? '已停止' : null);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 互关核对                                                            */
  /* ------------------------------------------------------------------ */

  async function runLookup(task) {
    const following = task.state.following.users;
    const followers = task.state.followers.users;
    const lookup = task.state.lookup || (task.state.lookup = {});
    const ids = [];
    const seen = new Set();
    for (const u of [...following, ...followers]) {
      if (u.id && u.id !== task.account.id && !seen.has(u.id)) {
        seen.add(u.id);
        ids.push(u.id);
      }
    }

    const followingSet = new Set(following.map((u) => u.id));
    const followersSet = new Set(followers.map((u) => u.id));

    setProgress(task, '核对互关', `正在核对 ${ids.length} 人的互关关系…`, {
      done: 0,
      total: ids.length,
    });

    const settings = await getSettings();
    let done = 0;
    let fallback = false;

    for (let i = 0; i < ids.length; i += 100) {
      if (cancelRequested) throw new CancelledError();
      const batch = ids.slice(i, i + 100);
      let parsed = null;

      if (!fallback) {
        const url = `${X_ORIGIN}/i/api/1.1/friendships/lookup.json?user_id=${encodeURIComponent(
          batch.join(',')
        )}`;
        const res = await api({ method: 'GET', url, useTransaction: false });
        if (res.status === 200) {
          try {
            const arr = JSON.parse(res.text);
            if (Array.isArray(arr)) {
              parsed = arr;
            }
          } catch (_) {}
        } else if (res.status === 429) {
          await waitForRateLimit(task, res.headers, '核对互关');
          i -= 100;
          continue;
        } else if (res.status === 401) {
          throw new Error('登录状态已失效，请先在 x.com 重新登录');
        } else {
          fallback = true;
          task.approximate = true;
        }
      }

      if (parsed) {
        for (const item of parsed) {
          const id = String(item.id_str || item.id || '');
          if (!id) continue;
          const conns = Array.isArray(item.connections) ? item.connections : [];
          lookup[id] = {
            following: conns.includes('following'),
            followsMe: conns.includes('followed_by'),
          };
        }
      }

      // 未被 lookup 覆盖的 id 用名单交集兜底
      for (const id of batch) {
        if (!lookup[id]) {
          lookup[id] = {
            following: followingSet.has(id),
            followsMe: followersSet.has(id),
          };
        }
      }

      done = Math.min(ids.length, i + 100);
      setProgress(task, '核对互关', `已核对 ${done} / ${ids.length} 人`, {
        done,
        total: ids.length,
      });
      saveTask(task);
      if (done < ids.length) await wait(jitter(settings.lookupDelayMs, 300));
    }

    if (fallback) {
      const exact = task.state.following.complete && task.state.followers.complete;
      task.approximate = !exact;
    }
    return lookup;
  }

  /* ------------------------------------------------------------------ */
  /* 合并写入关系记录                                                     */
  /* ------------------------------------------------------------------ */

  async function mergeRelations(task) {
    const accountId = task.account.id;
    const key = `lanRelations:${accountId}`;
    const existing = (await storageGet(key, {})) || {};
    const protectedMap = (await storageGet(`lanProtected:${accountId}`, {})) || {};
    const now = Date.now();

    const pool = new Map();
    for (const u of [...task.state.following.users, ...task.state.followers.users]) {
      if (u.id && u.id !== accountId) pool.set(u.id, u);
    }
    const followingSet = new Set(task.state.following.users.map((u) => u.id));
    const followersSet = new Set(task.state.followers.users.map((u) => u.id));

    for (const [id, u] of pool) {
      const prev = existing[id] || {};
      const lk = task.state.lookup[id];
      existing[id] = {
        id,
        screenName: u.screenName || prev.screenName || '',
        name: u.name || prev.name || '',
        avatar: u.avatar || prev.avatar || null,
        // lookup 是精确状态；个别账号查不到时退回名单成员关系
        following: lk ? !!lk.following : followingSet.has(id),
        followsMe: lk ? !!lk.followsMe : followersSet.has(id),
        protected: isProtected(protectedMap, id, u.screenName) || !!prev.protected,
        firstSeen: prev.firstSeen || now,
        lastSeen: now,
        scannedAt: now,
        scanId: task.id,
        stale: false,
        unfollowedAt: prev.unfollowedAt || null,
      };
    }

    // 本次没有扫描到的人保留记录，但标记为历史，避免用旧状态误导清理
    for (const [id, rel] of Object.entries(existing)) {
      if (!pool.has(id)) rel.stale = true;
    }

    await storageSet({ [key]: existing });

    // 统计只基于本次检测范围
    const values = [...pool.keys()].map((id) => existing[id]).filter(Boolean);
    const stats = {
      mutual: values.filter((r) => r.following && r.followsMe).length,
      notFollowingBack: values.filter((r) => r.following && !r.followsMe).length,
      notFollowedByMe: values.filter((r) => r.followsMe && !r.following).length,
      total: values.length,
    };
    return stats;
  }

  /* ------------------------------------------------------------------ */
  /* 检测任务                                                            */
  /* ------------------------------------------------------------------ */

  async function runDetection(task) {
    cancelRequested = false;
    try {
      task.status = 'running';
      task.progress = { phase: '准备', message: '正在连接 X…', done: 0, total: null };
      saveTask(task, true);
      await ensureAgent();

      const capsRef = { caps: await ensureTemplates(task) };
      setProgress(task, '准备', '接口参数就绪，开始读取名单…');

      if (!task.state.following) task.state.following = { users: [], cursor: null, complete: false, pages: 0 };
      if (!task.state.followers) task.state.followers = { users: [], cursor: null, complete: false, pages: 0 };

      await collectList(task, capsRef, 'Following');

      // 粉丝名单不是「谁没回关我」的必要条件：失败时降级，继续用 lookup 核对
      let followersError = null;
      try {
        await collectList(task, capsRef, 'Followers');
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        followersError = err && err.message ? err.message : String(err);
        task.state.followers = {
          users: [],
          cursor: null,
          complete: false,
          pages: 0,
          unavailable: true,
          error: followersError,
        };
        task.approximate = true;
        setProgress(
          task,
          '关注我的人',
          '粉丝名单读取失败，已跳过；仍会核对「谁没有回关我」'
        );
        saveTask(task);
      }

      // 粉丝第 2 页起无法重放时，用真实粉丝页自己滚动加载来补全
      const followerBucket = task.state.followers;
      const followersAuthFailed = !!(followersError && /登录状态已失效/.test(followersError));
      if (
        !followersAuthFailed &&
        !followerBucket.capped &&
        (!followerBucket.complete || followerBucket.partial || followerBucket.unavailable)
      ) {
        try {
          const harvested = await harvestFollowers(task, followerBucket);
          if (harvested && !harvested.skipped && mergeHarvest(task, followerBucket, harvested)) {
            if (followerBucket.users.length > 0 || !followerBucket.unavailable) followersError = null;
            setProgress(
              task,
              '关注我的人',
              followerBucket.partial
                ? `关注我的人：读取到 ${followerBucket.users.length} 人（后续页面未完全加载）`
                : `关注我的人：读取完成，共 ${followerBucket.users.length} 人`
            );
            saveTask(task, true);
          }
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          setProgress(task, '关注我的人', '粉丝后续页面读取失败，继续核对「谁没有回关我」…');
          saveTask(task);
        }
      }
      const followingBucket = task.state.following;
      task.approximate =
        !!followingBucket.partial ||
        !!followerBucket.partial ||
        !(followerBucket.complete || followerBucket.capped) ||
        !(followingBucket.complete || followingBucket.capped);

      await runLookup(task);

      setProgress(task, '整理记录', '正在合并关系记录…');
      const stats = await mergeRelations(task);
      if (followersError) stats.notFollowedByMe = null;
      const followingPartial = !!followingBucket.partial;
      const followersPartial = !!followerBucket.partial;
      const followingCapped = !!followingBucket.capped;
      const followersCapped = !!followerBucket.capped;
      const limited = followingCapped || followersCapped;

      await storageSet({
        [`lanScan:${task.account.id}`]: {
          taskId: task.id,
          at: Date.now(),
          stats,
          scannedFollowing: followingBucket.users.length,
          scannedFollowers: followersError ? 0 : followerBucket.users.length,
          approximate: !!task.approximate,
          limit: task.params.limit || null,
          limited,
          followingPartial,
          followingCapped,
          followersCapped,
          followersUnavailable: !!followersError,
          followersError,
          followersPartial,
        },
      });

      task.status = 'done';
      task.endedAt = Date.now();
      task.result = {
        ...stats,
        scannedFollowing: followingBucket.users.length,
        scannedFollowers: followersError ? 0 : followerBucket.users.length,
        approximate: !!task.approximate,
        limited,
        followingPartial,
        followingCapped,
        followersCapped,
        followersUnavailable: !!followersError,
        followersPartial,
      };
      task.progress = {
        phase: '完成',
        message:
          `检测完成：未回关 ${stats.notFollowingBack} 人` +
          (followersError ? '（粉丝名单未获取，「我未回关」暂不可用）' : '') +
          (followersPartial && !followersError ? '（粉丝名单不完整，「我未回关」为部分结果）' : '') +
          (followingPartial ? '（关注名单不完整，结果可能缺少部分账号）' : '') +
          (limited && task.params.limit ? `（本次按上限 ${task.params.limit} 人检测，并未扫描全部）` : '') +
          (task.approximate && !followersError && !followersPartial && !followingPartial
            ? '（名单未完整读取，结果为近似）'
            : ''),
        done: 1,
        total: 1,
      };
      saveTask(task, true);

      await updateAccount(task.account.id, {
        lastDetectAt: Date.now(),
        stats,
      });
      await appendHistory(task.account.id, {
        id: task.id,
        type: 'detect',
        at: Date.now(),
        stats,
      });
    } catch (err) {
      handleTaskError(task, err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 批量取关                                                            */
  /* ------------------------------------------------------------------ */

  async function destroyFriendship(task, id) {
    const url = `${X_ORIGIN}/i/api/1.1/friendships/destroy.json`;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (cancelRequested) throw new CancelledError();
      const res = await api({
        method: 'POST',
        url,
        useTransaction: false,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'user_id=' + encodeURIComponent(id),
      });
      if (res.status === 200) return { status: 'ok' };
      if (res.status === 404) return { status: 'missing' };
      if (res.status === 429) {
        await waitForRateLimit(task, res.headers, '批量取关');
        continue;
      }
      if (res.status === 401) throw new Error('登录状态已失效，请先在 x.com 重新登录');
      if (res.status === 403) return { status: 'blocked', code: 403 };
      if (res.status >= 500) {
        await wait(jitter(2500, 1500));
        continue;
      }
      return { status: 'failed', code: res.status };
    }
    return { status: 'failed', code: 'retry-exhausted' };
  }

  async function runUnfollow(task) {
    cancelRequested = false;
    const relKey = `lanRelations:${task.account.id}`;
    let relations = null;
    try {
      task.status = 'running';
      saveTask(task, true);
      await ensureAgent();

      const accountId = task.account.id;
      const protectedMap = (await storageGet(`lanProtected:${accountId}`, {})) || {};
      relations = (await storageGet(relKey, {})) || {};
      const settings = await getSettings();
      const items = task.state.items || [];
      let dirty = 0;
      let consecutiveFailures = 0;

      for (let i = task.state.index || 0; i < items.length; i++) {
        if (cancelRequested) throw new CancelledError();
        const item = items[i];

        if (isProtected(protectedMap, item.id, item.screenName)) {
          task.state.results.push({ id: item.id, status: 'protected' });
          task.state.index = i + 1;
          saveTask(task);
          continue;
        }

        const result = await destroyFriendship(task, item.id);
        task.state.index = i + 1;
        task.state.results.push({ id: item.id, status: result.status });

        if (result.status === 'ok' || result.status === 'missing') {
          consecutiveFailures = 0;
          relations[item.id] = {
            ...(relations[item.id] || {
              id: item.id,
              screenName: item.screenName,
              name: item.name,
              avatar: item.avatar,
            }),
            following: false,
            unfollowedAt: Date.now(),
          };
          dirty += 1;
        } else if (result.status !== 'protected') {
          consecutiveFailures += 1;
        }

        if (consecutiveFailures >= 5) {
          await storageSet({ [relKey]: relations });
          throw new Error('连续多次取关失败，任务已停止。请检查账号状态或稍后重试。');
        }

        const results = task.state.results;
        const okCount = results.filter((r) => r.status === 'ok' || r.status === 'missing').length;
        task.progress = {
          phase: '批量取关',
          message: `已处理 ${task.state.index} / ${items.length} 人`,
          done: task.state.index,
          total: items.length,
          ok: okCount,
          failed: results.filter((r) => r.status === 'failed' || r.status === 'blocked').length,
        };
        saveTask(task);
        if (dirty > 0 && (dirty % 3 === 0 || task.state.index === items.length)) {
          await storageSet({ [relKey]: relations });
          dirty = 0;
        }

        if (task.state.index < items.length) {
          const min = settings.unfollowMinDelayMs;
          const max = Math.max(min, settings.unfollowMaxDelayMs);
          await wait(min + Math.floor(Math.random() * (max - min)));
        }
      }

      await storageSet({ [relKey]: relations });

      const results = task.state.results;
      task.status = 'done';
      task.endedAt = Date.now();
      task.result = {
        total: items.length,
        ok: results.filter((r) => r.status === 'ok' || r.status === 'missing').length,
        failed: results.filter((r) => r.status === 'failed' || r.status === 'blocked').length,
        protected: results.filter((r) => r.status === 'protected').length,
      };
      task.progress = {
        phase: '完成',
        message: `取关完成：成功 ${task.result.ok} 人`,
        done: items.length,
        total: items.length,
      };
      saveTask(task, true);

      await appendHistory(accountId, {
        id: task.id,
        type: 'unfollow',
        at: Date.now(),
        result: task.result,
      });
    } catch (err) {
      if (relations) await storageSet({ [relKey]: relations });
      handleTaskError(task, err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 账号与历史                                                          */
  /* ------------------------------------------------------------------ */

  /* X 的 v1.1 verify_credentials 已被部分环境废弃（返回 404），
     这里按「旧接口 → 页面 DOM → users/show → 关注页 GraphQL 参数」逐级兜底。 */

  function viewerFromLegacyJson(user) {
    if (!user || (!user.id_str && !user.rest_id)) return null;
    return {
      id: String(user.id_str || user.rest_id),
      screenName: user.screen_name || user.screenName || '',
      name: user.name || user.screen_name || 'X 用户',
      avatar: user.profile_image_url_https
        ? user.profile_image_url_https.replace('_normal.', '_200x200.')
        : null,
      verified: !!user.verified,
      connectedAt: Date.now(),
      method: 'legacy-api',
    };
  }

  async function readDomViewer() {
    const reserved = new Set([
      'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose', 'search',
      'communities', 'jobs', 'premium', 'bookmarks', 'lists', 'grok', 'tos', 'privacy',
      'following', 'followers', 'login', 'logout', 'signup', 'account', 'about', 'download',
    ]);
    for (let attempt = 0; attempt < 12; attempt++) {
      let handle = null;
      let name = null;
      let avatar = null;

      const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (btn) {
        const text = btn.innerText || btn.textContent || '';
        const m = text.match(/@([A-Za-z0-9_]{1,15})/);
        if (m) handle = m[1];
        const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
        name = lines.find((l) => l && !l.startsWith('@')) || null;
        const img = btn.querySelector('img[src*="profile_images"]');
        if (img) avatar = img.getAttribute('src');
      }

      if (!handle) {
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        const href = link && (link.getAttribute('href') || '');
        const m = href && href.match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (m) handle = m[1];
      }

      if (!handle) {
        const links = Array.from(document.querySelectorAll('nav a[href^="/"]'));
        const hit = links.find((a) => {
          const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
          return m && !reserved.has(m[1].toLowerCase());
        });
        if (hit) handle = hit.getAttribute('href').slice(1);
      }

      if (handle) {
        return {
          screenName: handle,
          name: name || handle,
          avatar: avatar ? avatar.replace('_normal.', '_200x200.') : null,
        };
      }
      await wait(500);
    }
    return null;
  }

  async function resolveViewerByGraphql(handle, dom) {
    const warmStart = Date.now();
    try {
      chrome.runtime.sendMessage({
        type: 'lan:warmup',
        account: { screenName: handle },
        force: true,
      });
    } catch (_) {}

    let caps = await readCaptures();
    let info = null;
    while (Date.now() - warmStart < 45000) {
      await wait(800);
      caps = await readCaptures();
      const candidate = caps && caps.operations && caps.operations.Following;
      // 只接受本次预热新捕获的参数，避免复用旧 queryId
      if (candidate && candidate.variables && (candidate.at || 0) >= warmStart - 1000) {
        try {
          if (JSON.parse(candidate.variables).userId) {
            info = candidate;
            break;
          }
        } catch (_) {}
      }
    }
    if (!info || !info.variables) throw new Error('未能捕获关注页参数');

    let userId = null;
    try {
      userId = JSON.parse(info.variables).userId;
    } catch (_) {}
    if (!userId) throw new Error('关注页参数里没有 userId');

    const url = buildListUrl(caps, 'Following', { userId, cursor: null, count: 20 });
    const page = await api({
      method: 'GET',
      url,
      useTransaction: true,
      transactionId: info.transactionId || null,
    });
    if (page.status !== 200) throw new Error(`关注页校验 HTTP ${page.status}`);

    let wrapper = null;
    try {
      wrapper = JSON.parse(page.text).data.user.result;
    } catch (_) {}
    const sn = (wrapper && ((wrapper.core && wrapper.core.screen_name) || (wrapper.legacy && wrapper.legacy.screen_name))) || null;
    if (sn && sn.toLowerCase() !== handle.toLowerCase()) {
      throw new Error('页面账号与接口返回不一致');
    }
    const name =
      (wrapper && ((wrapper.core && wrapper.core.name) || (wrapper.legacy && wrapper.legacy.name))) ||
      (dom && dom.name) ||
      handle;
    const avatarRaw =
      (wrapper && ((wrapper.avatar && wrapper.avatar.image_url) || (wrapper.legacy && wrapper.legacy.profile_image_url_https))) ||
      (dom && dom.avatar) ||
      null;

    return {
      id: String(userId),
      screenName: sn || handle,
      name,
      avatar: avatarRaw ? String(avatarRaw).replace('_normal.', '_200x200.') : null,
      verified: !!(wrapper && wrapper.is_blue_verified),
      connectedAt: Date.now(),
      method: 'graphql-warmup',
    };
  }

  async function connectX() {
    await ensureAgent();
    const errors = [];

    // 1) 旧版 v1.1 接口
    const res = await api({
      method: 'GET',
      url: `${X_ORIGIN}/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false&include_email=false`,
      useTransaction: false,
    });
    if (res.status === 200) {
      let user = null;
      try {
        user = JSON.parse(res.text);
      } catch (_) {}
      const viewer = viewerFromLegacyJson(user);
      if (viewer) return viewer;
    }
    errors.push(`verify_credentials HTTP ${res.status}`);

    // 2) 从页面读取当前账号（侧边栏账号卡 / 个人主页链接）
    let dom = await readDomViewer();
    let handle = dom && dom.screenName;

    // 3) settings.json 兜底获取 handle
    if (!handle) {
      const setRes = await api({
        method: 'GET',
        url: `${X_ORIGIN}/i/api/1.1/account/settings.json`,
        useTransaction: false,
      });
      if (setRes.status === 200) {
        try {
          const s = JSON.parse(setRes.text);
          if (s.screen_name) {
            handle = s.screen_name;
            dom = { screenName: handle, name: s.screen_name, avatar: null };
          }
        } catch (_) {}
      }
      if (!handle) errors.push(`account/settings HTTP ${setRes.status}`);
    }

    if (!handle) {
      throw new Error(
        '连接 X 失败：' + errors.join('；') + '。请确认已在浏览器登录 x.com，并打开一次首页后重试。'
      );
    }

    // 4) users/show 兜底
    const showRes = await api({
      method: 'GET',
      url: `${X_ORIGIN}/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(handle)}`,
      useTransaction: false,
    });
    if (showRes.status === 200) {
      let user = null;
      try {
        user = JSON.parse(showRes.text);
      } catch (_) {}
      const viewer = viewerFromLegacyJson(user);
      if (viewer && viewer.id) {
        if (!viewer.screenName) viewer.screenName = handle;
        return viewer;
      }
    }
    errors.push(`users/show HTTP ${showRes.status}`);

    // 5) 从关注页 GraphQL 请求参数里拿 userId，再用关注页响应校验
    try {
      return await resolveViewerByGraphql(handle, dom);
    } catch (err) {
      errors.push(err && err.message ? err.message : String(err));
    }

    throw new Error(
      '连接 X 失败：' + errors.slice(0, 4).join('；') +
        '。请确认已登录 x.com，并能正常打开自己的「正在关注」页面。'
    );
  }

  async function updateAccount(accountId, patch) {
    const accounts = (await storageGet('lanAccounts', [])) || [];
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx >= 0) {
      accounts[idx] = { ...accounts[idx], ...patch };
      await storageSet({ lanAccounts: accounts });
    }
  }

  async function appendHistory(accountId, entry) {
    const key = `lanHistory:${accountId}`;
    const list = (await storageGet(key, [])) || [];
    list.unshift(entry);
    await storageSet({ [key]: list.slice(0, 30) });
  }

  function handleTaskError(task, err) {
    const cancelled = err instanceof CancelledError;
    task.status = cancelled ? 'stopped' : 'error';
    task.endedAt = Date.now();
    task.error = cancelled ? null : err && err.message ? err.message : String(err);
    task.progress = {
      ...(task.progress || {}),
      phase: cancelled ? '已停止' : '出错',
      message: cancelled ? '任务已手动停止，可稍后继续' : task.error,
    };
    saveTask(task, true);
  }

  /* ------------------------------------------------------------------ */
  /* 自检（只读，不修改名单）                                             */
  /* ------------------------------------------------------------------ */

  async function runSelfTest() {
    const startedAt = Date.now();
    const steps = [];
    const add = (name, status, detail) => {
      steps.push({ name, status, detail, at: Date.now() });
    };
    const result = () => ({
      ok: steps.every((s) => s.status === 'ok' || s.status === 'info'),
      steps,
      startedAt,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
    });

    try {
      await ensureAgent();
      const ping = await agentCall('ping', null, 5000);
      add('页面代理', ping.ok ? 'ok' : 'error', '已连接 ' + location.hostname);

      const me = await connectX();
      add(
        '账号连接',
        'ok',
        `@${me.screenName}（${me.name}）` + (me.method ? ` · ${me.method}` : '')
      );

      let caps = await readCaptures();
      const required = ['Following', 'Followers'];
      const needRefresh = !hasTemplates(caps) || !capturesFresh(caps);
      let warmStart = Date.now();
      const didRefresh = needRefresh;
      if (needRefresh) {
        try {
          chrome.runtime.sendMessage({ type: 'lan:warmup', account: me, force: true });
        } catch (_) {}
        while (Date.now() - warmStart < 45000) {
          await wait(800);
          caps = await readCaptures();
          // 两个接口都必须本次刷新，避免旧 queryId 混用
          if (hasTemplates(caps) && opsFreshSince(caps, required, warmStart - 1000)) break;
        }
      }
      if (!hasTemplates(caps)) {
        add('接口参数', 'error', '未能获取 Following / Followers 参数（请打开一次 x.com 的正在关注页后重试）');
        return result();
      }
      if (didRefresh && !opsFreshSince(caps, required, warmStart - 1000)) {
        const stale = required.filter(
          (op) => !caps.operations[op] || (caps.operations[op].at || 0) < warmStart - 1000
        );
        add(
          '接口参数',
          'error',
          `未能刷新 ${stale.join(' / ')} 的接口参数（可能是名单页未加载完成或被限流），请稍后重试`
        );
        return result();
      }
      const ageOf = (op) =>
        Math.max(0, Math.round((Date.now() - (caps.operations[op].at || Date.now())) / 60000));
      const txOf = (op) => (caps.operations[op].transactionId ? 'tx✓' : 'tx✗');
      const warmStatusOf = (op) => {
        const st = caps.operations[op].lastStatus;
        return st == null ? 'warm—' : `warm${st}`;
      };
      const hdrOf = (op) => 'hdr' + Object.keys(caps.operations[op].headers || {}).length;
      const bodyOf = (op) => (caps.operations[op].lastBody ? 'body✓' : 'body—');
      add(
        '接口参数',
        'ok',
        `Following ${ageOf('Following')}m ${txOf('Following')} ${warmStatusOf('Following')} ${hdrOf('Following')} ${bodyOf('Following')} · ` +
          `Followers ${ageOf('Followers')}m ${txOf('Followers')} ${warmStatusOf('Followers')} ${hdrOf('Followers')} ${bodyOf('Followers')}`
      );

      const describeFailure = (label, status, headers, bodyText) => {
        let detail = `HTTP ${status}`;
        if (status === 429) {
          const reset = headersNumber(headers, 'x-rate-limit-reset');
          if (reset) detail += `（限流，约 ${Math.max(0, Math.ceil((reset * 1000 - Date.now()) / 1000))} 秒后恢复）`;
        }
        if (status === 401 || status === 403) detail += '（登录状态失效或访问受限）';
        if (status === 404) detail += '（接口参数失效或接口已变更）';
        if (bodyText && status !== 429) {
          const snippet = String(bodyText).replace(/\s+/g, ' ').trim().slice(0, 140);
          if (snippet) detail += ` · ${snippet}`;
        }
        return { label, status: 'error', detail };
      };

      const probeList = async (op, cursor) => {
        let refreshed = false;
        let lastFailure = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const info = caps.operations[op];
          const tx =
            info.transactionId ||
            (caps.operations.Following && caps.operations.Following.transactionId) ||
            null;
          const url = buildListUrl(caps, op, { userId: me.id, cursor, count: 20 });
          const res = await api({
            method: 'GET',
            url,
            useTransaction: true,
            transactionId: tx,
            headers: info.headers || {},
          });
          if (res.status === 200) {
            try {
              const parsed = parseTimeline(JSON.parse(res.text));
              const remaining = headersNumber(res.headers, 'x-rate-limit-remaining');
              return { parsed, remaining };
            } catch (_) {
              return {
                failure: {
                  status: 'error',
                  detail: 'HTTP 200，但返回内容无法解析（可能被重定向到登录页）',
                },
              };
            }
          }
          lastFailure = describeFailure(op, res.status, res.headers, res.text);
          // 参数过期时自动重新捕获一次再试
          if (!refreshed && [400, 403, 404].includes(res.status)) {
            refreshed = true;
            add('接口参数刷新', 'info', `${op} 返回 ${res.status}，重新捕获参数后重试…`);
            const next = await refreshCapturesQuiet(me);
            if (next) {
              caps = next;
              continue;
            }
          }
          break;
        }

        // 用预热时捕获的原始变量原样重放一次，区分「我们的构造问题」和「X 端问题」
        if (!cursor) {
          const info = caps.operations[op];
          const rawVariables = info && (info.firstVariables || info.variables);
          if (info && rawVariables) {
            const params = new URLSearchParams();
            params.set('variables', rawVariables);
            if (info.features) params.set('features', info.features);
            if (info.fieldToggles) params.set('fieldToggles', info.fieldToggles);
            const rawUrl = `${X_ORIGIN}${info.fullPath || `${info.path}?${params.toString()}`}`;
            const rawRes = await api({
              method: 'GET',
              url: rawUrl,
              useTransaction: true,
              transactionId: info.transactionId || null,
              headers: info.headers || {},
            });
            if (rawRes.status === 200) {
              try {
                const parsed = parseTimeline(JSON.parse(rawRes.text));
                add(
                  '原样重放',
                  'info',
                  `${op} 原始参数 HTTP 200 · ${parsed.users.length} 人（需要调整变量构造）`
                );
                return {
                  parsed,
                  remaining: headersNumber(rawRes.headers, 'x-rate-limit-remaining'),
                };
              } catch (_) {}
            }
            add('原样重放', 'info', `${op} 原始参数 HTTP ${rawRes.status}`);
          }
        }

        return {
          failure: lastFailure || { status: 'error', detail: `${op} 请求失败` },
        };
      };

      const rateNote = (remaining) =>
        remaining == null ? '' : ` · 限流剩余 ${remaining}`;

      // 关注第一页
      const page1 = await probeList('Following', null);
      if (page1.failure) {
        add('读取关注第一页', page1.failure.status, page1.failure.detail);
        add('结论', 'info', '关键接口不可用，请先按上面的提示处理后重新自检。');
        return result();
      }
      const follow1 = page1.parsed;
      add(
        '读取关注第一页',
        follow1.users.length ? 'ok' : 'info',
        `HTTP 200 · 解析到 ${follow1.users.length} 人${follow1.cursor ? ' · 有下一页' : ' · 已到末尾'}${rateNote(page1.remaining)}`
      );

      // 关注第二页（验证 cursor 翻页）
      let follow2Users = [];
      if (follow1.cursor) {
        const page2 = await probeList('Following', follow1.cursor);
        if (page2.failure) {
          add('读取关注第二页', page2.failure.status, page2.failure.detail);
        } else {
          follow2Users = page2.parsed.users;
          add(
            '读取关注第二页',
            page2.parsed.users.length ? 'ok' : 'info',
            `HTTP 200 · 解析到 ${page2.parsed.users.length} 人${page2.parsed.cursor ? ' · 还有更多' : ' · 已到末尾'}${rateNote(page2.remaining)}`
          );
        }
      } else {
        add('读取关注第二页', 'info', '第一页已到末尾（关注数较少），跳过翻页检查');
      }

      // 粉丝第一页：优先使用网页端自己返回的响应（tx 无法重放）
      for (let i = 0; i < 10; i++) {
        if (caps.operations.Followers && caps.operations.Followers.lastBody) break;
        await wait(500);
        caps = await readCaptures();
      }
      let usedFollowersBody = false;
      const fInfo = caps.operations.Followers;
      const fBody = fInfo && fInfo.lastBody;
      const fBodyMatches =
        !fInfo || !fInfo.lastBodyRequestId || !fInfo.requestId || fInfo.lastBodyRequestId === fInfo.requestId;
      if (fBody && fBodyMatches) {
        try {
          const parsedBody = parseTimeline(JSON.parse(fBody));
          add(
            '读取粉丝第一页',
            'ok',
            `网页端原始响应 200 · ${parsedBody.users.length} 人${
              parsedBody.cursor ? ' · 有下一页' : ' · 已到末尾'
            } · 使用捕获响应`
          );
          usedFollowersBody = true;
        } catch (_) {}
      }
      if (!usedFollowersBody) {
        const followersPage = await probeList('Followers', null);
        if (followersPage.failure) {
          add(
            '读取粉丝第一页',
            'warn',
            followersPage.failure.detail +
              ' · 主检测仍可用（「未回关我」通过互关核对完成），仅「我未回关」本次不可用'
          );
        } else {
          add(
            '读取粉丝第一页',
            followersPage.parsed.users.length ? 'ok' : 'info',
            `HTTP 200 · 解析到 ${followersPage.parsed.users.length} 人${followersPage.parsed.cursor ? ' · 有下一页' : ' · 已到末尾'}${rateNote(followersPage.remaining)}`
          );
        }
      }

      // 互关核对
      const ids = [...follow1.users, ...follow2Users].slice(0, 10).map((u) => u.id);
      if (!ids.length) {
        add('互关核对', 'warn', '没有可核对的对象（关注列表为空）');
      } else {
        const lookupRes = await api({
          method: 'GET',
          url: `${X_ORIGIN}/i/api/1.1/friendships/lookup.json?user_id=${encodeURIComponent(
            ids.join(',')
          )}`,
          useTransaction: false,
        });
        if (lookupRes.status === 200) {
          let arr = [];
          try {
            arr = JSON.parse(lookupRes.text);
          } catch (_) {}
          if (Array.isArray(arr)) {
            const mutual = arr.filter(
              (x) => Array.isArray(x.connections) && x.connections.includes('following') && x.connections.includes('followed_by')
            ).length;
            const followedByMe = arr.filter(
              (x) => Array.isArray(x.connections) && x.connections.includes('following')
            ).length;
            add(
              '互关核对',
              'ok',
              `HTTP 200 · 核对 ${arr.length} 人 · 正向关注 ${followedByMe} 人 · 互关 ${mutual} 人`
            );
          } else {
            add('互关核对', 'warn', 'HTTP 200，但返回格式异常');
          }
        } else {
          add('互关核对', 'error', `HTTP ${lookupRes.status}`);
        }
      }

      // 写接口探测：使用无效 ID(0)，不会指向任何真实用户，也不会取关任何人
      try {
        const probeWrite = (body) =>
          api({
            method: 'POST',
            url: `${X_ORIGIN}/i/api/1.1/friendships/destroy.json`,
            useTransaction: false,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          });
        const writeRes = await probeWrite('user_id=0');
        if (writeRes.status === 200) {
          add('写接口探测', 'ok', 'HTTP 200 · 端点可达（使用无效 ID，未改动任何账号）');
        } else if (writeRes.status === 400 || writeRes.status === 422) {
          add('写接口探测', 'ok', `HTTP ${writeRes.status} · 端点可达（使用无效 ID，未改动任何账号）`);
        } else if (writeRes.status === 401 || writeRes.status === 403) {
          add('写接口探测', 'error', `HTTP ${writeRes.status} · 登录状态或权限异常`);
        } else if (writeRes.status === 429) {
          add('写接口探测', 'warn', 'HTTP 429 · 当前限流，稍后可重试');
        } else if (writeRes.status === 404) {
          // 无效 ID 也可能返回 404；再用空 body 探一次，区分「参数错误」和「接口不存在」
          const emptyRes = await probeWrite('');
          if ([200, 400, 422].includes(emptyRes.status)) {
            add(
              '写接口探测',
              'ok',
              `HTTP ${writeRes.status}/${emptyRes.status} · 端点可达（使用无效 ID，未改动任何账号）`
            );
          } else {
            add(
              '写接口探测',
              'warn',
              `HTTP 404 · 写接口可能已变更或废弃（未执行任何取关），真实取关前请先用小号验证`
            );
          }
        } else {
          add('写接口探测', 'warn', `HTTP ${writeRes.status} · 端点有响应，请留意`);
        }
      } catch (err) {
        add('写接口探测', 'error', err && err.message ? err.message : String(err));
      }

      const errors = steps.filter((s) => s.status === 'error').length;
      const warns = steps.filter((s) => s.status === 'warn').length;
      add(
        '结论',
        'info',
        errors || warns
          ? `完成 ${steps.length} 项检查：${errors} 项异常，${warns} 项警告，请见上方明细。`
          : '全部检查通过：真实环境下的登录态、分页读取、互关核对与写接口均可用。'
      );
      return result();
    } catch (err) {
      add('异常', 'error', err && err.message ? err.message : String(err));
      return result();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 指令处理                                                            */
  /* ------------------------------------------------------------------ */

  let cancelRequested = false;
  let runningTaskId = null;

  async function handleCommand(command, payload) {
    switch (command) {
      case 'ping':
        return { ok: true, href: location.href };
      case 'connect':
        return { ok: true, account: await connectX() };
      case 'detect':
        if (runningTaskId) return { ok: false, error: '已有任务在运行' };
        runningTaskId = payload.task.id;
        runDetection(payload.task).finally(() => (runningTaskId = null));
        return { ok: true, taskId: payload.task.id };
      case 'unfollow':
        if (runningTaskId) return { ok: false, error: '已有任务在运行' };
        runningTaskId = payload.task.id;
        runUnfollow(payload.task).finally(() => (runningTaskId = null));
        return { ok: true, taskId: payload.task.id };
      case 'cancel':
        cancelRequested = true;
        return { ok: true };
      case 'harvest':
        return startHarvest(payload);
      case 'harvest-stop':
        if (harvest) harvest.cancelled = true;
        return { ok: true };
      case 'selftest':
        return { ok: true, report: await runSelfTest() };
      case 'certificate':
        return agentCall('ping');
      default:
        throw new Error('未知指令：' + command);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'lan:cmd') return;
    handleCommand(msg.command, msg.payload || {})
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  });

  // 页面卸载时通知后台（尽力而为）
  window.addEventListener('pagehide', () => {
    if (!runningTaskId) return;
    try {
      chrome.runtime.sendMessage({ type: 'lan:task-unloading', taskId: runningTaskId });
    } catch (_) {}
  });

  // 告知后台本页已就绪
  function hello() {
    try {
      chrome.runtime.sendMessage({ type: 'lan:hello', href: location.href });
    } catch (_) {}
  }
  hello();
  setTimeout(hello, 1500);
})();
