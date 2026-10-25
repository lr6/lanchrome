/**
 * 关注整理所 — MAIN world 页面代理
 * 运行在 x.com 页面上下文中，负责：
 *  1. 旁路记录 X 客户端真实请求里的鉴权头、GraphQL queryId、features
 *  2. 使用页面自己的 cookie / 会话代替扩展发起请求（避免 CORS）
 *
 * 与隔离世界（bridge.js）通过 window.postMessage 通信，命名空间 LAN_BLUE。
 */
(() => {
  'use strict';
  if (window.__LAN_BLUE_AGENT__) return;
  window.__LAN_BLUE_AGENT__ = true;

  const NS = 'LAN_BLUE';
  // 这些接口的请求上下文/transaction-id 无法可靠重放，改为捕获网页端自己的响应
  const CAPTURE_BODY_OPS = new Set(['Following', 'Followers']);
  // X Web 客户端的公开 Bearer（非用户凭据），仅在尚未捕获到真实请求时兜底
  const PUBLIC_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const state = {
    bearer: null,
    csrf: null,
    lastTransactionId: null,
    operations: Object.create(null),
    lastSeenAt: 0,
  };
  let requestSeq = 0;

  const nativeFetch = window.fetch.bind(window);

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function emit(event, data) {
    try {
      window.postMessage({ __lan: NS, dir: 'event', event, data }, location.origin);
    } catch (_) {}
  }

  function readCookie(name) {
    try {
      const hit = document.cookie
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(name + '='));
      return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
    } catch (_) {
      return null;
    }
  }

  function getCsrf() {
    if (!state.csrf) state.csrf = readCookie('ct0');
    return state.csrf;
  }

  function cleanCapturedHeaders(headers) {
    const forbidden = /^(host|content-length|connection|cookie|origin|referer|user-agent|accept-encoding|te|trailer|transfer-encoding|upgrade-insecure-requests|priority)$/i;
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (forbidden.test(k) || /^sec-/i.test(k) || /^proxy-/i.test(k)) continue;
      out[k] = String(v);
    }
    return out;
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((v, k) => (out[k.toLowerCase()] = v));
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => (out[String(k).toLowerCase()] = v));
      } else if (typeof headers === 'object') {
        Object.entries(headers).forEach(([k, v]) => (out[k.toLowerCase()] = v));
      }
    } catch (_) {}
    return out;
  }

  function summarizeOperations() {
    const out = {};
    for (const [op, info] of Object.entries(state.operations)) {
      out[op] = {
        operation: op,
        queryId: info.queryId,
        path: info.path,
        features: info.features,
        fieldToggles: info.fieldToggles,
        variables: info.variables,
        transactionId: info.transactionId,
        requestId: info.requestId,
        lastStatus: info.lastStatus,
        at: info.at,
      };
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 旁路捕获                                                            */
  /* ------------------------------------------------------------------ */

  function noteRequest(method, rawUrl, headers) {
    try {
      if (!rawUrl) return null;
      const url = new URL(String(rawUrl), location.origin);
      if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(url.hostname)) return null;
      if (!url.pathname.startsWith('/i/api/')) return null;

      const auth = headers['authorization'];
      if (auth && /^Bearer\s+/i.test(auth)) {
        state.bearer = auth.replace(/^Bearer\s+/i, '');
      }

      const tx = headers['x-client-transaction-id'];
      if (tx) state.lastTransactionId = tx;

      if (!url.pathname.startsWith('/i/api/graphql/')) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      // i / api / graphql / <queryId> / <OperationName>
      const queryId = parts[3];
      const operation = parts[4];
      if (!queryId || !operation) return null;

      const at = Date.now();
      const requestId = 'r' + ++requestSeq;
      const variables = url.searchParams.get('variables');
      const features = url.searchParams.get('features');
      const fieldToggles = url.searchParams.get('fieldToggles');
      const prev = state.operations[operation] || {};

      // 单独记住「第一页」的变量（没有 cursor 的那次请求），后续分页再替换 cursor
      let firstVariables = prev.firstVariables || null;
      if (variables) {
        try {
          const v = JSON.parse(variables);
          if (!v || !v.cursor) firstVariables = variables;
        } catch (_) {}
      }

      state.operations[operation] = {
        operation,
        queryId,
        path: url.pathname,
        fullPath: url.pathname + url.search,
        method: method || 'GET',
        headers: cleanCapturedHeaders(headers),
        variables: variables || prev.variables || null,
        firstVariables,
        features: features || prev.features || null,
        fieldToggles: fieldToggles || prev.fieldToggles || null,
        transactionId: tx || prev.transactionId || null,
        requestId,
        at,
      };
      state.lastSeenAt = at;

      emit('capture', state.operations[operation]);
      return { operation, requestId };
    } catch (_) {
      return null;
    }
  }

  function patchFetch() {
    window.fetch = function (input, init) {
      let note = null;
      try {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        const url = isRequest ? input.url : String(input);
        const method = (init && init.method) || (isRequest ? input.method : 'GET');
        let headers = null;
        if (init && init.headers) headers = init.headers;
        else if (isRequest) headers = input.headers;
        note = noteRequest(method, url, headersToObject(headers));
      } catch (_) {}

      const promise = nativeFetch(input, init);
      if (note && promise && typeof promise.then === 'function') {
        promise
          .then((res) => {
            try {
              emit('captureResult', {
                operation: note.operation,
                requestId: note.requestId,
                status: res.status,
                at: Date.now(),
              });
            } catch (_) {}
            if (CAPTURE_BODY_OPS.has(note.operation) && res.ok) {
              try {
                res
                  .clone()
                  .text()
                  .then((text) => {
                    try {
                      emit('captureBody', {
                        operation: note.operation,
                        requestId: note.requestId,
                        status: res.status,
                        text: String(text).slice(0, 2000000),
                        at: Date.now(),
                      });
                    } catch (_) {}
                  })
                  .catch(() => {});
              } catch (_) {}
            }
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  function patchXhr() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto) return;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const nativeSetHeader = proto.setRequestHeader;

    proto.open = function (method, url) {
      this.__lan = { method, url, headers: {} };
      return nativeOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      try {
        if (this.__lan) this.__lan.headers[String(name).toLowerCase()] = value;
      } catch (_) {}
      return nativeSetHeader.apply(this, arguments);
    };
    proto.send = function () {
      let note = null;
      try {
        if (this.__lan) note = noteRequest(this.__lan.method, this.__lan.url, this.__lan.headers);
      } catch (_) {}
      if (note) {
        try {
          this.addEventListener(
            'loadend',
            () => {
              try {
                emit('captureResult', {
                  operation: note.operation,
                  requestId: note.requestId,
                  status: this.status,
                  at: Date.now(),
                });
              } catch (_) {}
              if (CAPTURE_BODY_OPS.has(note.operation) && this.status === 200) {
                let text = null;
                try {
                  text = this.responseText;
                } catch (_) {
                  try {
                    if (this.responseType === 'json' && this.response) text = JSON.stringify(this.response);
                    else if (this.responseType === 'arraybuffer' && this.response) {
                      text = new TextDecoder().decode(this.response);
                    }
                  } catch (_) {}
                }
                if (text) {
                  emit('captureBody', {
                    operation: note.operation,
                    requestId: note.requestId,
                    status: 200,
                    text: String(text).slice(0, 2000000),
                    at: Date.now(),
                  });
                }
              }
            },
            { once: true }
          );
        } catch (_) {}
      }
      return nativeSend.apply(this, arguments);
    };
  }

  patchFetch();
  patchXhr();

  /* ------------------------------------------------------------------ */
  /* 请求执行                                                            */
  /* ------------------------------------------------------------------ */

  async function apiRequest(payload = {}) {
    const {
      method = 'GET',
      url,
      headers = {},
      body = null,
      useTransaction = false,
      transactionId = null,
      timeoutMs = 45000,
    } = payload;

    if (!url) throw new Error('缺少请求地址');

    const target = new URL(url, location.origin);
    const finalHeaders = {
      authorization: 'Bearer ' + (state.bearer || PUBLIC_BEARER),
      'x-csrf-token': getCsrf() || '',
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
      ...headers,
    };
    const tx = transactionId || state.lastTransactionId;
    if (useTransaction && tx && !finalHeaders['x-client-transaction-id']) {
      finalHeaders['x-client-transaction-id'] = tx;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await nativeFetch(target.toString(), {
        method,
        headers: finalHeaders,
        body,
        credentials: 'include',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const outHeaders = {};
    try {
      res.headers.forEach((v, k) => (outHeaders[k.toLowerCase()] = v));
    } catch (_) {}

    return {
      status: res.status,
      ok: res.ok,
      url: res.url,
      headers: outHeaders,
      text,
      at: Date.now(),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 消息处理                                                            */
  /* ------------------------------------------------------------------ */

  async function handle(cmd, payload) {
    switch (cmd) {
      case 'ping':
        return {
          ok: true,
          href: location.href,
          loggedIn: !!getCsrf(),
          hasBearer: !!state.bearer,
          operations: Object.keys(state.operations),
        };
      case 'api':
        return { ok: true, response: await apiRequest(payload) };
      case 'captures':
        return {
          ok: true,
          bearer: state.bearer || null,
          lastTransactionId: state.lastTransactionId,
          operations: summarizeOperations(),
        };
      default:
        throw new Error('未知指令：' + cmd);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__lan !== NS || data.dir !== 'req') return;
    const id = data.id;
    Promise.resolve()
      .then(() => handle(data.cmd, data.payload))
      .then((result) => {
        window.postMessage({ __lan: NS, dir: 'res', id, ok: true, ...result }, location.origin);
      })
      .catch((err) => {
        window.postMessage(
          { __lan: NS, dir: 'res', id, ok: false, error: err && err.message ? err.message : String(err) },
          location.origin
        );
      });
  });

  // 让 bridge 知道代理已就绪
  emit('ready', { href: location.href, at: Date.now() });
})();
