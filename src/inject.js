/* DeepSeek 对话导出 —— 页面上下文（MAIN world）采集器
 *
 * 为什么要在页面里跑：
 *   chat.deepseek.com 的对话是从自己的 /api/v0/* 接口拿的。只要在页面脚本之前
 *   把 fetch / XMLHttpRequest 包一层，就能原样留存「服务端返回的那份数据」，
 *   既不用猜 DOM 的 hash class，也不会因为改版丢字段。
 *
 * 采集范围（只记录这些，其余请求一律不碰）：
 *   /api/v0/chat/history_messages   —— 某会话的完整历史消息
 *   /api/v0/chat/completion        —— 当前生成中的流式回复（SSE）
 *   /api/v0/chat/regenerate        —— 重新生成
 *   /api/v0/chat_session*          —— 会话列表 / 会话元信息
 *
 * 不发送任何数据到外部，只通过 window.postMessage 交给同页面的隔离世界脚本。
 */
(function () {
  'use strict';

  if (window.__DS_EXPORT_INJECTED__) return;
  window.__DS_EXPORT_INJECTED__ = true;

  var CHANNEL = 'DS_EXPORT_V1';
  var MAX_RECORDS = 400;                 // 最多保留多少条 API 记录
  var MAX_TEXT = 4 * 1024 * 1024;        // 单条响应最多留 4MB
  var MAX_JSON_KEEP = 1536 * 1024;       // 超过这个大小就不再额外存一份解析后的对象

  var INTEREST = [
    /\/api\/v0\/chat\/history_messages/i,
    /\/api\/v0\/chat\/completion/i,
    /\/api\/v0\/chat\/regenerate/i,
    /\/api\/v0\/chat_session/i
  ];

  var records = [];
  var nextId = 1;

  /* ---------------------------------------------------------------- 基础工具 */

  function interested(url) {
    if (!url) return false;
    for (var i = 0; i < INTEREST.length; i++) {
      if (INTEREST[i].test(url)) return true;
    }
    return false;
  }

  function clip(text, limit) {
    var s = text == null ? '' : String(text);
    var max = limit || MAX_TEXT;
    return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s;
  }

  function post(msg) {
    try {
      msg.__dsExport = CHANNEL;
      window.postMessage(msg, window.location.origin);
    } catch (e) {
      /* 跨源/结构化克隆失败时静默 */
    }
  }

  function kindOf(url) {
    if (/history_messages/i.test(url)) return 'history';
    if (/chat_session/i.test(url)) return 'session_list';
    if (/\/completion|regenerate/i.test(url)) return 'completion';
    return 'other';
  }

  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v); });
        return out;
      }
      if (Object.prototype.toString.call(h) === '[object Array]') {
        h.forEach(function (pair) {
          if (pair && pair.length === 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
        });
        return out;
      }
      if (typeof h === 'object') {
        Object.keys(h).forEach(function (k) {
          var v = h[k];
          if (v != null) out[String(k).toLowerCase()] = String(v);
        });
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function parseSse(text) {
    var events = [];
    String(text || '').split(/\r?\n\r?\n/).forEach(function (block) {
      var data = [];
      block.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('data:') === 0) data.push(line.slice(5).trim());
      });
      var payload = data.join('');
      if (!payload || payload === '[DONE]') return;
      try {
        events.push(JSON.parse(payload));
      } catch (e) {
        events.push({ __raw: clip(payload, 4000) });
      }
    });
    return events;
  }

  function finish(rec, extra) {
    rec.state = 'done';
    rec.finished_at = Date.now();
    if (extra) {
      Object.keys(extra).forEach(function (k) { rec[k] = extra[k]; });
    }
    if (rec.kind === 'completion' && rec.sse_text) {
      try { rec.events = parseSse(rec.sse_text); } catch (e) { /* ignore */ }
    }
    records.push(rec);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    post({ type: 'record', record: rec });
  }

  function makeRecord(kind, url, method, reqHeaders, reqBody, extra) {
    var rec = {
      id: nextId++,
      kind: kind,
      url: String(url),
      method: String(method || 'GET').toUpperCase(),
      request_headers: reqHeaders || {},
      request_body: reqBody == null ? null : clip(reqBody, 256 * 1024),
      captured_at: Date.now(),
      state: 'open'
    };
    if (extra) Object.keys(extra).forEach(function (k) { rec[k] = extra[k]; });
    post({ type: 'begin', record: rec });
    return rec;
  }

  /* ------------------------------------------------------------- fetch 拦截 */

  var nativeFetch = window.fetch;

  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      var method = 'GET';
      var body = null;
      try {
        if (typeof input === 'string') {
          url = input;
        } else if (input && typeof input.url === 'string') {
          url = input.url;
          method = input.method || 'GET';
        }
        if (init && init.method) method = init.method;
        if (init && typeof init.body === 'string') body = init.body;
      } catch (e) { /* ignore */ }

      var promise = nativeFetch.apply(this, arguments);
      if (!interested(url)) return promise;

      return promise.then(function (res) {
        var rec = makeRecord(
          kindOf(url),
          url,
          method,
          headersToObject(init && init.headers),
          body,
          { http_status: res.status }
        );
        try {
          captureResponse(rec, res.clone());
        } catch (e) {
          finish(rec, { error: 'clone failed: ' + (e && e.message || e) });
        }
        return res;
      });
    };
  }

  async function captureResponse(rec, res) {
    var ct = '';
    try { ct = res.headers.get('content-type') || ''; } catch (e) { /* ignore */ }

    if (/text\/event-stream/i.test(ct) || rec.kind === 'completion') {
      await captureStream(rec, res);
      return;
    }

    try {
      var text = await res.text();
      rec.response_text = clip(text);
      rec.content_type = ct;
      if (text.length <= MAX_JSON_KEEP) {
        try { rec.response_json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
      }
      finish(rec);
    } catch (e) {
      finish(rec, { error: String(e && e.message || e) });
    }
  }

  async function captureStream(rec, res) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      finish(rec, { error: 'no readable body' });
      return;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var raw = '';
    try {
      for (;;) {
        var step = await reader.read();
        if (step.value) raw += decoder.decode(step.value, { stream: true });
        if (step.done) break;
        if (raw.length > MAX_TEXT) {
          raw = raw.slice(0, MAX_TEXT) + '\n…[truncated]';
          break;
        }
      }
      raw += decoder.decode();
      rec.content_type = 'text/event-stream';
      rec.sse_text = clip(raw);
      finish(rec);
    } catch (e) {
      finish(rec, { sse_text: clip(raw), error: String(e && e.message || e) });
    }
  }

  /* -------------------------------------------------------- XMLHttpRequest */

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    var XHR = window.XMLHttpRequest.prototype;
    var nativeOpen = XHR.open;
    var nativeSend = XHR.send;

    XHR.open = function (method, url) {
      try {
        this.__dsExportMeta = {
          method: method,
          url: String(url),
          headers: {}
        };
      } catch (e) { /* ignore */ }
      return nativeOpen.apply(this, arguments);
    };

    var nativeSetHeader = XHR.setRequestHeader;
    XHR.setRequestHeader = function (name, value) {
      try {
        if (this.__dsExportMeta) {
          this.__dsExportMeta.headers[String(name).toLowerCase()] = String(value);
        }
      } catch (e) { /* ignore */ }
      return nativeSetHeader.apply(this, arguments);
    };

    XHR.send = function (body) {
      var meta = this.__dsExportMeta;
      if (meta && interested(meta.url)) {
        var rec = makeRecord(
          kindOf(meta.url),
          meta.url,
          meta.method,
          meta.headers,
          typeof body === 'string' ? body : null
        );
        var xhr = this;
        var settle = function () {
          try {
            var type = xhr.responseType;
            if (type && type !== 'text') return;
            var text = '';
            try { text = xhr.responseText || ''; } catch (e) { text = ''; }
            rec.http_status = xhr.status;
            rec.response_text = clip(text);
            if (text.length <= MAX_JSON_KEEP) {
              try { rec.response_json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
            }
            finish(rec);
          } catch (e) {
            finish(rec, { error: String(e && e.message || e) });
          }
        };
        this.addEventListener('loadend', settle, { once: true });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------- 与隔离世界脚本握手 */

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__dsExportReq === 'dump') {
      post({
        type: 'dump',
        records: records.slice(),
        handshake: { injected_at: window.__DS_EXPORT_INJECTED_AT__ || null }
      });
    }
  });

  window.__DS_EXPORT_INJECTED_AT__ = Date.now();
})();
