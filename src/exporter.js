/* DeepSeek 对话导出 —— 导出核心（隔离世界）
 *
 * 取数优先级：
 *   1. 直接调 DeepSeek 历史接口（去掉 cache_version / cache_reset_at，否则只会拿到「缓存增量」空数组）
 *   2. 页面里已经采集到的原始响应（同样做完整性判断，取最全的那条）
 *   3. SSE 流式回复补齐
 *   4. DOM 文本兜底（先走 refine.js 的「只取正文块」；拿不到才退回老的宽松启发式）
 *
 * 结构见 README「导出结构」。
 */
(function () {
  'use strict';

  if (window.DSExportCore) return;

  var VERSION = '1.7.1';
  var ORIGIN = 'https://chat.deepseek.com';
  var SCHEMA = 'deepseek-chat-export/v1';
  var FORMATS = ['chat', 'markdown', 'text'];
  var TOKEN_KEYS = ['user_token', 'userToken', 'user_token_local', 'user_token_v2'];
  var CACHE_PARAMS = ['cache_version', 'cache_reset_at', 'cache_reset', 'client_cache_version'];
  var DOM_NOISE = /^(复制|展开|收起|再生成|重新生成|停止生成|Copy|复制代码|运行|编辑|删除)$/;
  // 「已搜索到 / 已阅读 N 个网页」这类块不是用户提问
  var SEARCH_LIST_RE = /(已搜索到|已阅读|正在搜索)\s*\d*\s*个网页?/;

  /* --------------------------------------------------------------- 小工具 */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function stampForFilename(date) {
    var d = date || new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() +
      pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function slug(text, max) {
    var s = String(text == null ? '' : text)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return (s || 'chat').slice(0, max || 60);
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return undefined;
  }

  function looksLikeUuid(s) {
    return typeof s === 'string' && /^[0-9a-zA-Z_-]{8,64}$/.test(s);
  }

  function shortText(value, limit) {
    return String(value == null ? '' : value).slice(0, limit || 120);
  }

  /* ----------------------------------------------------------------- token */

  function coerceToken(raw) {
    if (!raw) return null;
    var v = String(raw).trim();
    if (!v) return null;

    if (v.charAt(0) === '{' || v.charAt(0) === '"') {
      try { v = JSON.parse(v); } catch (e) { return null; }
    }
    var guard = 0;
    while (v && typeof v === 'object' && guard++ < 6) {
      v = v.value !== undefined ? v.value
        : v.token !== undefined ? v.token
        : v.access_token !== undefined ? v.access_token
        : v.tokenValue !== undefined ? v.tokenValue
        : null;
    }
    if (typeof v !== 'string') return null;

    v = v.replace(/^"|"$/g, '').trim();
    if (v.length < 12 || /\s/.test(v)) return null;
    return v;
  }

  function readToken() {
    var store = window.localStorage;
    if (!store) return null;

    for (var i = 0; i < TOKEN_KEYS.length; i++) {
      var t = coerceToken(store.getItem(TOKEN_KEYS[i]));
      if (t) return t;
    }
    var keys = [];
    try {
      for (var k in store) {
        if (Object.prototype.hasOwnProperty.call(store, k) && /token/i.test(k)) keys.push(k);
      }
    } catch (e) { /* ignore */ }
    for (var j = 0; j < keys.length; j++) {
      var t2 = coerceToken(store.getItem(keys[j]));
      if (t2) return t2;
    }
    return null;
  }

  function hasAuthToken() {
    return !!readToken();
  }

  /* ------------------------------------------------------------------ HTTP */

  var replayHeaders = null; // 从采集到的真实请求里学来的请求头

  var HEADER_BLOCKLIST = [
    'content-length', 'host', 'connection', 'cookie', 'origin', 'referer',
    'accept-encoding', 'accept-language', 'sec-fetch-dest', 'sec-fetch-mode',
    'sec-fetch-site', 'priority', 'pragma', 'cache-control'
  ];

  function learnHeaders(records) {
    if (replayHeaders) return replayHeaders;
    for (var i = records.length - 1; i >= 0; i--) {
      var r = records[i];
      if (!r || !r.request_headers) continue;
      var src = r.request_headers;
      if (!src.authorization) continue;
      var keep = {};
      Object.keys(src).forEach(function (k) {
        if (HEADER_BLOCKLIST.indexOf(k.toLowerCase()) === -1) keep[k] = src[k];
      });
      if (keep.authorization) {
        replayHeaders = keep;
        return keep;
      }
    }
    return null;
  }

  async function apiRequest(method, url, body, extraHeaders) {
    var headers = { 'content-type': 'application/json' };
    if (extraHeaders) {
      Object.keys(extraHeaders).forEach(function (k) {
        headers[k.toLowerCase()] = extraHeaders[k];
      });
    }
    // 优先用 localStorage 里的最新 token；拿不到才退回捕获到的（可能过期）
    var token = readToken();
    if (token) headers.authorization = 'Bearer ' + token;

    var init = {
      method: method,
      headers: headers,
      credentials: 'include',
      cache: 'no-store'
    };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    var res = await fetch(url, init);
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, text: text, json: json, url: url, method: method };
  }

  function stripCacheParams(url) {
    try {
      var u = new URL(url, ORIGIN);
      CACHE_PARAMS.forEach(function (k) { u.searchParams.delete(k); });
      return u.pathname + (u.search || '');
    } catch (e) {
      return url;
    }
  }

  function stripCacheFromBody(body) {
    if (!body) return body;
    if (typeof body !== 'string') {
      var clone = Object.assign({}, body);
      CACHE_PARAMS.forEach(function (k) { delete clone[k]; });
      return clone;
    }
    try {
      var obj = JSON.parse(body);
      if (obj && typeof obj === 'object') {
        CACHE_PARAMS.forEach(function (k) { delete obj[k]; });
        return JSON.stringify(obj);
      }
    } catch (e) { /* 非 JSON，原样返回 */ }
    return body;
  }

  /* --------------------------------------------------- 记录 / 采集数据查询 */

  function recordSessionId(rec) {
    if (!rec) return null;
    try {
      if (rec.url) {
        var m = rec.url.match(/chat_session_id=([^&]+)/i);
        if (m) return decodeURIComponent(m[1]);
      }
      if (rec.request_body) {
        var body = typeof rec.request_body === 'string' ? JSON.parse(rec.request_body) : rec.request_body;
        if (body && body.chat_session_id) return body.chat_session_id;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function capturedTemplate(records, kind) {
    for (var i = records.length - 1; i >= 0; i--) {
      var r = records[i];
      if (!r || r.kind !== kind || !r.url || !r.request_headers) continue;
      if (kind === 'history' && !/history_messages/i.test(r.url)) continue;
      if (kind === 'session_list' && !/fetch_page|list|query/i.test(r.url)) continue;
      return r;
    }
    return null;
  }

  /* ------------------------------------------------------------- 消息归一化 */

  function pickMessages(payload) {
    var queue = [payload];
    var roots = [];
    var guard = 0;

    while (queue.length && guard++ < 60) {
      var node = queue.shift();
      if (!node || typeof node !== 'object' || roots.indexOf(node) !== -1) continue;
      roots.push(node);
      ['data', 'biz_data', 'bizData', 'result'].forEach(function (k) {
        var child = node[k];
        if (child && typeof child === 'object' && roots.indexOf(child) === -1) queue.push(child);
      });
    }

    for (var i = 0; i < roots.length; i++) {
      var keys = ['chat_messages', 'chatMessages', 'messages', 'chat_message_list'];
      for (var j = 0; j < keys.length; j++) {
        if (Array.isArray(roots[i][keys[j]]) && roots[i][keys[j]].length) {
          return { messages: roots[i][keys[j]], container: roots[i] };
        }
      }
    }
    for (var k = 0; k < roots.length; k++) {
      if (Array.isArray(roots[k].chat_messages)) {
        return { messages: [], container: roots[k] };
      }
    }
    return { messages: [], container: null };
  }

  /**
   * 判断一份历史响应到底是不是「全量」。
   * DeepSeek 带 cache_version 请求时只返回增量：chat_messages 可能是空的，
   * 此时 chat_session.current_message_id 仍指向最后一条消息，可用作完整性基准。
   */
  function historyInfo(payload) {
    var picked = pickMessages(payload);
    var container = picked.container || {};
    var session = container.chat_session || container.chatSession || {};
    var lastId = 0;

    picked.messages.forEach(function (m) {
      var mid = Number(pick(m, ['message_id', 'messageId']) || 0);
      if (mid > lastId) lastId = mid;
    });

    var target = Number(pick(session, ['current_message_id', 'currentMessageId']) || 0);
    return {
      messages: picked.messages,
      container: picked.container,
      session: session,
      lastId: lastId,
      target: target,
      complete: picked.messages.length > 0 && (!target || lastId >= target) &&
        pickRole(picked.messages[0]) === 'user' && !picked.messages.some(function (m) {
          var parent = pick(m, ['parent_id', 'parent_message_id', 'parentMessageId']);
          return parent != null && String(parent) !== '0' && !picked.messages.some(function (p) {
            return String(pick(p, ['message_id', 'messageId', 'id'])) === String(parent);
          });
        })
    };
  }

  function pickContent(m) {
    var c = pick(m, ['content', 'text', 'message', 'answer']);
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(function (part) {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      }).join('').trim();
    }
    if (c && typeof c === 'object') {
      if (typeof c.text === 'string') return c.text;
      if (typeof c.content === 'string') return c.content;
    }
    return '';
  }

  function pickRole(m) {
    var raw = String(pick(m, ['role', 'author', 'sender', 'from']) || '').toLowerCase();
    if (raw.indexOf('user') !== -1 || raw.indexOf('human') !== -1) return 'user';
    if (raw.indexOf('assistant') !== -1 || raw.indexOf('ai') !== -1 || raw.indexOf('bot') !== -1) return 'assistant';
    if (raw.indexOf('system') !== -1) return 'system';
    if (m && m.role === 0) return 'user';
    if (m && m.role === 1) return 'assistant';
    return 'unknown';
  }

  function toIso(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && /^\d{10}(?:\.\d+)?$|^\d{13}$/.test(value.trim())) value = Number(value);
    if (typeof value === 'number') {
      var ms = value > 1e12 ? value : value * 1000;
      var d = new Date(ms);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof value === 'string') {
      var parsed = new Date(value);
      return isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    return null;
  }

  function mapMessage(m, opts) {
    // 只要聊天记录时，连 role / content 以外的元数据字段都不写 —— 文件里不该出现接口味道的东西
    var meta = !opts || opts.includeMeta !== false;
    var out = {
      message_id: meta ? pick(m, ['message_id', 'messageId', 'id']) || null : undefined,
      role: pickRole(m),
      content: pickContent(m),
      status: meta ? pick(m, ['status']) || null : undefined,
      inserted_at: meta ? pick(m, ['inserted_at', 'insertedAt', 'created_at']) || null : undefined,
      inserted_at_iso: toIso(pick(m, ['inserted_at', 'insertedAt', 'created_at'])),
      thinking_elapsed_secs: meta ? pick(m, ['thinking_elapsed_secs', 'thinkingElapsedSecs']) || null : undefined,
      search_status: meta ? pick(m, ['search_status']) || null : undefined
    };
    Object.keys(out).forEach(function (k) { if (out[k] === undefined) delete out[k]; });

    if (opts && opts.includeThinking) {
      out.thinking = pick(m, ['thinking_content', 'thinkingContent', 'reasoning_content']) || null;
    }
    var searchResults = pick(m, ['search_results', 'searchResults']);
    if (searchResults) out.search_results = searchResults;
    var files = pick(m, ['files', 'attachments']);
    if (files && (Array.isArray(files) ? files.length : true)) out.files = files;
    var tips = pick(m, ['tips']);
    if (tips) out.tips = tips;
    var tokens = pick(m, ['accumulated_token_usage', 'token_usage']);
    if (tokens) out.token_usage = tokens;

    if (opts && opts.includeRaw) out.raw = m;
    return out;
  }

  function normalizeHistory(payload, sessionId, opts) {
    var info = historyInfo(payload);
    var sessionMeta = info.session || {};
    var messages = info.messages
      .map(function (m) { return mapMessage(m, opts); })
      .filter(function (m) { return m.content || (m.raw && JSON.stringify(m.raw).length > 40); });

    return {
      messages: messages,
      session: {
        title: pick(sessionMeta, ['title', 'name']) || null,
        model_type: pick(sessionMeta, ['model_type', 'modelType']) || null,
        created_at: pick(sessionMeta, ['inserted_at', 'created_at']) || null,
        updated_at: pick(sessionMeta, ['updated_at', 'updatedAt']) || null,
        pinned: pick(sessionMeta, ['pinned']) || null,
        current_message_id: info.target || null
      },
      session_id: sessionId || pick(sessionMeta, ['id']),
      complete: info.complete,
      last_message_id: info.lastId,
      expected_message_id: info.target
    };
  }

  /* ----------------------------------------------- SSE 流式回复 → 消息补全 */

  function reconstructCompletion(rec) {
    var content = '';
    var thinking = '';
    var events = rec.events || [];

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev || typeof ev !== 'object') continue;
      var value = ev.v !== undefined ? ev.v : ev.content;
      if (typeof value !== 'string') continue;
      var path = String(ev.p || ev.path || '');
      if (/thinking/i.test(path)) thinking += value;
      else if (/content/i.test(path) || path === '') content += value;
    }
    return { content: content, thinking: thinking, event_count: events.length };
  }

  function appendCompletionTurns(out, records, sessionId, opts, note) {
    var known = {};
    out.messages.forEach(function (m) {
      if (m && typeof m.content === 'string') known[m.content.trim()] = true;
    });

    var used = 0;
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec || rec.kind !== 'completion') continue;
      var recSession = recordSessionId(rec);
      if (sessionId && recSession && recSession !== sessionId) continue;

      var rebuilt = reconstructCompletion(rec);
      if (!rebuilt.content) continue;
      var key = rebuilt.content.trim();
      if (known[key]) continue;
      known[key] = true;

      var entry = {
        message_id: null,
        role: 'assistant',
        content: rebuilt.content,
        source: 'sse',
        captured_at: rec.captured_at || null,
        search_status: null
      };
      if (opts.includeThinking && rebuilt.thinking) entry.thinking = rebuilt.thinking;
      if (opts.includeRaw) entry.raw_sse = rec.sse_text || null;

      out.messages.push(entry);
      used++;
    }
    if (used && note) note('从流式回复补齐 ' + used + ' 条未落库的回复', 'info');
  }

  /* ------------------------------------------------------------ DOM 兜底 */

  function insideEditor(el) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 12) {
      var tag = node.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
      if (node.getAttribute && node.getAttribute('contenteditable') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  }

  function commonAncestor(elements) {
    if (!elements.length) return null;
    var root = elements[0];
    for (var i = 1; i < elements.length; i++) {
      while (root && !root.contains(elements[i])) root = root.parentElement;
      if (!root) return null;
    }
    return root;
  }

  /**
   * 取文本，同时临时解除「长消息折叠 / line-clamp」的限制。
   * DeepSeek 长用户消息默认被折叠，直接 innerText 会截断 —— 这也是之前导不全的原因之一。
   */
  function unclampedText(el) {
    var touched = [];
    try {
      var nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*')));
      nodes.forEach(function (n) {
        if (!n.style) return;
        var s = window.getComputedStyle(n);
        if (!s) return;
        var clamp = s.webkitLineClamp || s.lineClamp;
        var hidden = s.overflow === 'hidden' || s.overflowY === 'hidden';
        var cappedHeight = s.maxHeight && s.maxHeight !== 'none';
        if ((clamp && clamp !== 'none') || (hidden && cappedHeight)) {
          touched.push({ node: n, style: n.getAttribute('style') });
          try {
            n.style.webkitLineClamp = 'unset';
            n.style.lineClamp = 'unset';
            n.style.maxHeight = 'none';
            n.style.overflow = 'visible';
          } catch (e) { /* ignore */ }
        }
      });
      return (el.innerText || '').trim();
    } finally {
      touched.forEach(function (t) {
        if (t.style === null) t.node.removeAttribute('style');
        else t.node.setAttribute('style', t.style);
      });
    }
  }

  /** innerText 拿不到时（跨 world 的极端情况）退回 textContent，免得兜底也返回空 */
  function domText(el) {
    try {
      var text = (el.innerText || '').trim();
      if (text) return text;
    } catch (e) { /* ignore */ }
    if (window.DSExportRefine && window.DSExportRefine._internals.safeText) {
      return window.DSExportRefine._internals.safeText(el);
    }
    return String(el.textContent || '').trim();
  }

  function usableTextBlock(el) {
    if (!el) return '';
    if (el.querySelector('button, svg, textarea, input, [contenteditable="true"]')) return '';
    if (el.querySelector('.ds-markdown')) return '';
    var text = domText(el);
    if (!text) return '';
    if (DOM_NOISE.test(text)) return '';
    return text;
  }

  function previousTextBlock(start, root) {
    var node = start;
    var hops = 0;
    while (node && node !== root && hops++ < 8) {
      var prev = node.previousElementSibling;
      while (prev) {
        var text = usableTextBlock(prev);
        if (text) return { el: prev, text: text };
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  var lastDomDiagnostics = null;

  function extractDom(opts) {
    var useRefine = !opts || opts.refine !== false;
    var tried = [];

    // 每条策略都记一笔：正常时走第一层，出问题时能看出卡在哪
    var report = function (strategy, count) {
      lastDomDiagnostics = { strategy: strategy, count: count, tried: tried.slice() };
    };

    // 主路径：1.2 之前那套（.ds-markdown + 往前找提问 + innerText），
    // 只额外加两个「自动剔除」的小补丁：跳过思考块、找不到提问时用提问气泡兜底。
    var primary = [];
    try {
      primary = extractDomLoose();
      tried.push('主提取：' + ((primary && primary.length) || 0) + ' 条');
    } catch (e) {
      tried.push('主提取出错：' + (e && e.message));
    }
    if (primary && primary.length) {
      report('loose', primary.length);
      return stripMeta(primary);
    }

    // 主路径拿不到东西时，才轮到这些备用策略
    var direct = [];
    try {
      direct = extractDomDirect();
      tried.push('直接提取：' + ((direct && direct.length) || 0) + ' 条');
    } catch (e) {
      tried.push('直接提取出错：' + (e && e.message));
    }
    if (direct && direct.length) {
      report('direct', direct.length);
      return stripMeta(direct);
    }

    if (useRefine && window.DSExportRefine) {
      // 更干净的一套：只取「正文块」的最小容器（思考 / 搜索 / 按钮都不带）
      var clean = [];
      try {
        clean = window.DSExportRefine.extractClean();
        tried.push('标准提取：' + ((clean && clean.length) || 0) + ' 条');
      } catch (e) {
        tried.push('标准提取出错：' + (e && e.message));
      }
      if (clean && clean.length) {
        report('refine', clean.length);
        return stripMeta(clean.map(function (n) {
          return { message_id: null, role: n.role, content: n.content, source: 'dom' };
        }));
      }
    } else if (useRefine) {
      tried.push('refine 脚本没加载（window.DSExportRefine 不存在）');
    }

    // 最后一道防线：不看类名的通用扫描（页面改版时救命）
    var generic = [];
    if (window.DSExportRefine && window.DSExportRefine.extractGeneric) {
      try {
        generic = window.DSExportRefine.extractGeneric();
        tried.push('通用扫描：' + ((generic && generic.length) || 0) + ' 条');
      } catch (e) {
        tried.push('通用扫描出错：' + (e && e.message));
      }
    }
    if (generic && generic.length) {
      report('generic', generic.length);
      return stripMeta(generic.map(function (n) {
        return { message_id: null, role: n.role, content: n.content, source: 'dom' };
      }));
    }

    // 保底通道：只要页面上有 .ds-markdown，就直接按 textContent 取。
    // 不依赖任何布局计算 / 容器判断 / 清理逻辑 —— 这是「老版本一直能导出」的那条路，
    // 保证最坏情况下也不会交出一个空文件。
    var raw = [];
    try {
      raw = extractRawDump();
      tried.push('保底直取：' + raw.length + ' 条');
    } catch (e) {
      tried.push('保底直取出错：' + (e && e.message));
    }
    if (raw.length) {
      report('raw', raw.length);
      return stripMeta(raw);
    }

    report(null, 0);
    return [];
  }

  /**
   * 最朴素的取法：.ds-markdown → textContent。
   * 故意不做任何加工，只求「拿到东西」；但思考块仍要排除（它同样带 .ds-markdown）。
   */
  function extractRawDump() {
    var ids = Array.prototype.slice.call(document.querySelectorAll('.ds-markdown'));
    if (!ids.length) return [];
    var isThinking = window.DSExportRefine && window.DSExportRefine._internals
      ? window.DSExportRefine._internals.looksLikeThinking
      : null;
    var out = [];
    ids.forEach(function (md) {
      if (isThinking && isThinking(md, document.documentElement)) return;
      var text = String(md.textContent || '').replace(/\r/g, '').trim();
      if (!text || text.length < 2) return;
      out.push({ role: 'assistant', content: text });
    });
    return out;
  }

  /** 只要聊天记录时，DOM 兜底结果里也不带 message_id / source 这类元数据 */
  function stripMeta(messages) {
    return (messages || []).map(function (m) {
      return { role: m.role, content: m.content };
    });
  }

  /**
   * 最直接的取法：回答块 `.ds-markdown` + 提问气泡 `.fbb737a4`，各取各的，再按文档顺序排。
   *
   * 为什么不用「从回答块往前找提问」那种做法：那依赖两者的 DOM 关系，
   * 页面结构一变就一个提问都找不到（日志里「0 轮提问」就是这么来的）。
   * 这里两个选择器互相独立，谁在不在都不影响另一个。
   */
  function extractDomDirect() {
    var mds = Array.prototype.slice.call(document.querySelectorAll('.ds-markdown'));
    if (!mds.length) return [];

    // 嵌套的只留最外层
    mds = mds.filter(function (md) {
      return !mds.some(function (other) { return other !== md && other.contains(md); });
    });

    var blocks = [];
    var thinkingSkipped = 0;
    var isThinking = window.DSExportRefine && window.DSExportRefine._internals
      ? window.DSExportRefine._internals.looksLikeThinking
      : null;

    mds.forEach(function (md) {
      if (insideEditor(md)) return;
      // 思考过程也带 .ds-markdown，这里借助 refine 的结构判据排掉（判不出来就保留，宁可多不可少）
      if (isThinking) {
        try {
          if (isThinking(md, document.documentElement)) { thinkingSkipped++; return; }
        } catch (e) { /* ignore */ }
      }
      blocks.push({ el: md, role: 'assistant' });
    });

    var bubbles = Array.prototype.slice.call(document.querySelectorAll('.fbb737a4'));
    // 嵌套气泡只留最外层
    var bubbleEls = bubbles.filter(function (el) {
      if (insideEditor(el)) return false;
      return !bubbles.some(function (other) { return other !== el && el.contains(other); });
    });
    bubbleEls.forEach(function (el) {
      // 只要气泡本身没被某个回答块包住，就算一条提问
      var buried = mds.some(function (md) { return md !== el && md.contains(el); });
      if (buried) return;
      blocks.push({ el: el, role: 'user' });
    });

    if (!blocks.length) return [];
    blocks.sort(function (a, b) {
      if (a.el === b.el) return 0;
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    var out = [];
    var seenText = {};
    blocks.forEach(function (b) {
      var text = String(domText(b.el) || '').trim();
      if (!text) return;
      if (b.role === 'user' && SEARCH_LIST_RE.test(text)) return;   // 搜索列表不是提问
      var key = b.role + '|' + text.slice(0, 100);
      if (seenText[key]) return;
      seenText[key] = true;
      out.push({ message_id: null, role: b.role, content: text, source: 'dom' });
    });

    return out;
  }

  /** 在文档里找到这个回答块之前最近的一个提问气泡 */
  function nearestUserBubble(md, bubbles) {
    var best = null;
    (bubbles || []).forEach(function (b) {
      if (b === md || b.contains(md) || md.contains(b)) return;
      var rel = md.compareDocumentPosition(b);
      // PRECEDING：b 在 md 前面
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) best = b;
    });
    return best;
  }

  /** 宽松兜底：refine 没拿到东西时，仍按老办法从 DOM 里凑一份 */
  function extractDomLoose() {
    var mds = Array.prototype.slice.call(document.querySelectorAll('.ds-markdown'));
    if (!mds.length) return [];

    // 去掉互相嵌套的重复块，只留最外层
    mds = mds.filter(function (md) {
      return !mds.some(function (other) { return other !== md && other.contains(md); });
    });

    // 以所有答案块的最近公共祖先作为对话范围，天然排除侧边栏
    var root = commonAncestor(mds) || document.querySelector('#root') || document.body;
    var items = [];
    var seen = [];

    // 补丁 1：思考过程也带 .ds-markdown，用结构判据（前面紧挨着「已思考（用时N秒）」）排掉
    var isThinking = window.DSExportRefine && window.DSExportRefine._internals
      ? window.DSExportRefine._internals.looksLikeThinking
      : null;
    var bubbles = Array.prototype.slice.call(document.querySelectorAll('.fbb737a4'));

    mds.forEach(function (md) {
      var assistantText = domText(md);
      if (!assistantText) return;
      if (insideEditor(md)) return;
      if (isThinking) {
        try {
          // 判不出来时保留（宁可多带，不能丢）
          if (isThinking(md, document.documentElement)) return;
        } catch (e) { /* ignore */ }
      }

      var user = previousTextBlock(md, root);
      // 「已搜索到 N 个网页」这类块不是用户提问，别把它当成上一句
      if (user && SEARCH_LIST_RE.test(user.text)) user = null;

      // 补丁 2：原版找不到提问就没了（日志里「0 轮提问」），这里退回提问气泡兜底
      if (!user) {
        var bubble = nearestUserBubble(md, bubbles);
        if (bubble) {
          var bubbleText = domText(bubble);
          if (bubbleText && !SEARCH_LIST_RE.test(bubbleText)) user = { el: bubble, text: bubbleText };
        }
      }

      if (user && seen.indexOf(user.el) === -1) {
        seen.push(user.el);
        items.push({ el: user.el, role: 'user', content: user.text });
      }
      items.push({ el: md, role: 'assistant', content: assistantText });
    });

    items.sort(function (a, b) {
      if (a.el === b.el) return 0;
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return items.map(function (n) {
      return {
        message_id: null,
        role: n.role,
        content: n.content,
        source: 'dom'
      };
    });
  }

  function domTitle() {
    var t = (document.title || '')
      .replace(/\s*[-|·]\s*DeepSeek\s*$/i, '')
      .replace(/^DeepSeek\s*[-|·]?\s*/i, '')
      .trim();
    if (t && !/^deepseek$/i.test(t)) return t;
    return null;
  }

  /* --------------------------------------------------------- 会话列表收集 */

  function addRef(map, id, title) {
    if (!looksLikeUuid(id)) return;
    if (!map[id]) map[id] = { id: id, title: title || null, order: Object.keys(map).length };
    else if (title && !map[id].title) map[id].title = title;
  }

  function collectDomSessionRefs(map) {
    var links = document.querySelectorAll('a[href*="/a/chat/s/"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var m = href.match(/\/a\/chat\/s\/([^/?#]+)/);
      if (!m) continue;
      var id = decodeURIComponent(m[1]);
      if (!looksLikeUuid(id)) continue;
      var title = (links[i].innerText || links[i].textContent || '').trim().split('\n')[0];
      addRef(map, id, title || null);
    }
  }

  function walkSessionObjects(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 10 || out.length > 500) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length && i < 200; i++) walkSessionObjects(node[i], out, depth + 1);
      return;
    }
    var idValue = pick(node, ['id', 'chat_session_id', 'session_id']);
    var title = pick(node, ['title', 'name']);
    if (typeof idValue === 'string' && looksLikeUuid(idValue) &&
      (typeof title === 'string' || pick(node, ['updated_at', 'updatedAt']))) {
      out.push({ id: idValue, title: typeof title === 'string' ? title : null });
    }
    Object.keys(node).forEach(function (k) {
      var v = node[k];
      if (v && typeof v === 'object') walkSessionObjects(v, out, depth + 1);
    });
  }

  async function fetchSessionList(records, note) {
    var attempts = [];
    var tmpl = capturedTemplate(records, 'session_list');
    if (tmpl) {
      attempts.push({
        method: tmpl.method,
        url: tmpl.url,
        body: tmpl.method === 'POST' ? tmpl.request_body : undefined,
        headers: tmpl.request_headers
      });
    }
    attempts.push({ method: 'GET', url: ORIGIN + '/api/v0/chat_session/fetch_page?count=200&offset=0', headers: replayHeaders });
    attempts.push({ method: 'POST', url: ORIGIN + '/api/v0/chat_session/fetch_page', body: { count: 200 }, headers: replayHeaders });

    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      try {
        var res = await apiRequest(a.method, a.url, a.body, a.headers);
        if (res.status === 200 && res.json) {
          var found = [];
          walkSessionObjects(res.json, found, 0);
          if (found.length) return res.json;
          if (note) note('会话列表接口返回了 0 个会话', 'warn');
        }
      } catch (e) { /* 试下一个 */ }
      await sleep(100);
    }
    return null;
  }

  async function collectRefs(ctx) {
    var map = {};
    collectDomSessionRefs(map);

    for (var i = 0; i < ctx.records.length; i++) {
      var rec = ctx.records[i];
      if (!rec || rec.kind !== 'session_list' || !rec.response_json) continue;
      var found = [];
      walkSessionObjects(rec.response_json, found, 0);
      found.forEach(function (s) { addRef(map, s.id, s.title); });
    }

    if (ctx.hasToken) {
      var json = await fetchSessionList(ctx.records, ctx.note);
      if (json) {
        var list = [];
        walkSessionObjects(json, list, 0);
        var before = Object.keys(map).length;
        list.forEach(function (s) { addRef(map, s.id, s.title); });
        var added = Object.keys(map).length - before;
        if (added > 0) ctx.note('接口补充了 ' + added + ' 个会话', 'info');
      } else {
        ctx.note('会话列表接口没通，只能用侧边栏里已渲染的会话', 'warn');
      }
    }

    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.order - b.order; });
  }

  /* ------------------------------------------------------------ 历史消息拉取 */

  function buildHistoryAttempts(sessionId, ctx) {
    var attempts = [];
    var seen = {};

    function add(attempt) {
      var key = attempt.method + ' ' + attempt.url;
      if (seen[key]) return;
      seen[key] = 1;
      attempts.push(attempt);
    }

    var tmpl = capturedTemplate(ctx.records, 'history');
    if (tmpl) {
      add({
        label: '捕获模板（去缓存参数）',
        method: tmpl.method || 'GET',
        url: stripCacheParams(tmpl.url),
        body: tmpl.method === 'POST' ? stripCacheFromBody(tmpl.request_body) : undefined,
        headers: tmpl.request_headers
      });
    }

    var base = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId);
    add({ label: 'GET 全量', method: 'GET', url: base, headers: replayHeaders });
    add({ label: 'GET cache_version=0', method: 'GET', url: base + '&cache_version=0', headers: replayHeaders });
    add({ label: 'POST 全量', method: 'POST', url: '/api/v0/chat/history_messages', body: { chat_session_id: sessionId }, headers: replayHeaders });

    return attempts;
  }

  async function fetchHistory(sessionId, ctx) {
    var attempts = buildHistoryAttempts(sessionId, ctx);
    var failures = [];
    var best = null;

    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      try {
        var res = await apiRequest(a.method, a.url, a.body, a.headers);
        if (res.status === 200 && res.json) {
          var info = historyInfo(res.json);
          if (info.messages.length) {
            var candidate = { response: res, attempt: a, info: info, failures: failures };
            if (info.complete) return candidate;
            if (!best || info.messages.length > best.info.messages.length) best = candidate;
            failures.push(a.label + ' → 只回 ' + info.messages.length + ' 条（疑似缓存增量）');
          } else {
            failures.push(a.label + ' → 200 但消息为空');
          }
        } else {
          failures.push(a.label + ' → HTTP ' + res.status + ' ' + shortText(res.text));
        }
      } catch (e) {
        failures.push(a.label + ' → ' + (e && e.message || e));
      }
      await sleep(120);
    }

    if (best) {
      best.failures = failures;
      return best;
    }
    var err = new Error('全部接口都没有返回可用历史');
    err.failures = failures;
    throw err;
  }

  function findHistoryRecord(records, sessionId) {
    var best = null;
    var bestCount = -1;

    for (var i = records.length - 1; i >= 0; i--) {
      var rec = records[i];
      if (!rec || rec.kind !== 'history' || !rec.response_json) continue;

      var recId = recordSessionId(rec);
      if (!recId && rec.url && sessionId) {
        if (rec.url.indexOf(sessionId) === -1) continue;
        recId = sessionId;
      }
      if (sessionId && recId && recId !== sessionId) continue;

      var info = historyInfo(rec.response_json);
      if (info.messages.length > bestCount) {
        bestCount = info.messages.length;
        best = { rec: rec, info: info };
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ 单会话构建 */

  var TITLE_NOISE = /(已深度思考（用时[^）]*）|已深度思考|深度思考中|已搜索到\s*\d+\s*个网页|已阅读\s*\d+\s*个网页|正在生成中?|已停止生成)/g;

  /** 会话标题：优先用侧边栏 / 接口给的标题；DOM 兜底的会话也给一个像样的名字 */
  function sessionTitle(ref, messages) {
    var title = ref && ref.title ? String(ref.title) : '';
    if (!title) title = domTitle() || '';
    if (!title) {
      var firstUser = null;
      (messages || []).some(function (m) {
        if (m && m.role === 'user' && String(m.content || '').trim()) { firstUser = m; return true; }
        return false;
      });
      if (firstUser) title = String(firstUser.content);
    }
    // DOM 抓到的标题偶尔会把思考过程 / 搜索状态一起带进来，这里统一清掉
    title = title.replace(TITLE_NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (!title) return '未命名对话';
    return title.length > 40 ? title.slice(0, 40) + '…' : title;
  }

  /* ------------------------------------------------ 自动上滚：加载全部历史 */

  /** 找出承载消息的那个可滚动容器 */
  function findScroller() {
    var best = null;
    var bestDepth = -1;
    var all = document.querySelectorAll('div,main,section');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.querySelector || !el.querySelector('.ds-markdown')) continue;
      var scrollable = el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200;
      if (!scrollable) continue;
      var depth = 0;
      for (var n = el; n; n = n.parentElement) depth++;
      if (depth > bestDepth) { bestDepth = depth; best = el; }
    }
    return best;
  }

  /** 去重用的键：压掉空白，取前 120 字 */
  function blockKey(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /**
   * 边滚边收集（虚拟滚动唯一可靠的做法）。
   *
   * 页面只渲染看得见的那一段：滚到顶部，底部最新的消息就会被卸载掉。
   * 所以不能「先滚到顶、再提取」，必须每滚一屏就提取一次，把结果累积起来去重。
   * 这里从底部往上滚，每屏收集到的块插到最前面，最终顺序就是对话顺序。
   */
  async function collectByScrolling(ctx) {
    var scroller = findScroller();
    if (!scroller) {
      ctx.note('没找到可滚动的对话容器，只提取当前屏幕这一屏（可能不全）', 'warn');
      return null;
    }

    var acc = [];
    var seen = {};
    var addedTotal = 0;
    var noNew = 0;
    var steps = 0;
    var maxSteps = 1200;
    var topStable = 0;
    var reachedTop = false;

    // 先落到最底部，确保最新的消息也在场
    try { scroller.scrollTop = scroller.scrollHeight; } catch (e) { /* ignore */ }
    await sleep(280);

    for (var step = 0; step < maxSteps; step++) {
      var items;
      try { items = extractDom(); } catch (e) { items = []; }
      if (!items || !items.length) items = extractRawDump();

      var added = 0;
      // 倒序遍历 + unshift：本屏在下面，所以插到累积结果前面
      for (var i = (items || []).length - 1; i >= 0; i--) {
        var key = items[i].role + '|' + blockKey(items[i].content);
        if (!key || seen[key]) continue;
        seen[key] = 1;
        acc.unshift({ role: items[i].role, content: items[i].content });
        added++;
      }
      addedTotal += added;
      steps++;

      // Long messages can span many screens; only stop at the top or a stuck scroll.

      var before = scroller.scrollTop;
      if (before <= 1) {
        // Reaching the current top can trigger asynchronous history loading.
        var height = scroller.scrollHeight;
        await sleep(1000);
        if (added === 0 && scroller.scrollTop <= 1 && scroller.scrollHeight === height) topStable++;
        else topStable = 0;
        if (topStable >= 4) { reachedTop = true; break; }
        continue;
      }
      topStable = 0;
      var viewH = scroller.clientHeight || 600;
      try { scroller.scrollTop = Math.max(0, before - Math.round(viewH * 0.8)); } catch (e) { break; }
      await sleep(300);

      // 滚不动了（到底/容器不是真滚动）又没新内容，收工
      if (scroller.scrollTop === before && added === 0) break;
    }

    if (!reachedTop) ctx.note('⚠ 滚动尚未确认到达历史开头（达到扫描上限或容器无法滚动），结果可能缺少前面的对话', 'warn');
    ctx.note('滚动收集：' + steps + ' 屏，累计 ' + acc.length + ' 条去重后的正文', 'info');
    return acc.length ? acc : null;
  }

  function attachTimes(messages, candidates) {
    function key(m) { return m.role + '|' + String(m.content || '').replace(/\s+/g, ' ').trim(); }
    var index = new Map();
    candidates.forEach(function(m) {
      if (!m.inserted_at_iso) return;
      var k = key(m);
      if (!index.has(k)) index.set(k, new Set());
      index.get(k).add(m.inserted_at_iso);
    });
    var counts = new Map();
    messages.forEach(function(m) {var k=key(m);counts.set(k,(counts.get(k)||0)+1);});
    messages.forEach(function(m) {
      if (m.inserted_at_iso) return;
      var k=key(m), times=index.get(k);
      if (counts.get(k) === 1 && times && times.size === 1) m.inserted_at_iso=Array.from(times)[0];
    });
  }

  async function buildSession(ref, ctx) {
    var id = ref && ref.id ? ref.id : null;
    var out = {
      chat_session_id: id,
      title: ref && ref.title ? ref.title : null,
      url: id ? ORIGIN + '/a/chat/s/' + id : null,
      source: null,
      incomplete: false,
      messages: []
    };

    var timeCandidates = [];
    // 1) 直接问接口
    if (id && ctx.hasToken) {
      try {
        var got = await fetchHistory(id, ctx);
        var norm = normalizeHistory(got.response.json, id, ctx);
        timeCandidates = timeCandidates.concat(norm.messages);
        if (norm.messages.length) {
          out.messages = norm.messages;
          out.source = 'api';
          out.session = norm.session;
          out.api = {
            url: got.response.url,
            method: got.response.method,
            status: got.response.status,
            complete: !!got.info.complete,
            last_message_id: got.info.lastId,
            expected_message_id: got.info.target
          };
          if (!out.title && norm.session.title) out.title = norm.session.title;
          if (!got.info.complete) {
            out.incomplete = true;
            ctx.note('接口只回了 ' + norm.messages.length + ' 条（最新 #' + got.info.lastId +
              ' / 期望 #' + got.info.target + '），像缓存增量', 'warn');
          }
        }
      } catch (e) {
        ctx.note('会话 ' + id + ' 拉取失败', 'warn');
        (e.failures || [e.message]).slice(0, 4).forEach(function (f) {
          ctx.note('  ' + f, 'warn');
        });
      }
    }

    // 2) 页面里已经采集到的原始响应（取消息最多的那条）
    if ((!out.messages.length || out.incomplete) && id) {
      var found = findHistoryRecord(ctx.records, id);
      if (found) {
        var norm2 = normalizeHistory(found.rec.response_json, id, ctx);
        if (norm2.messages.length > out.messages.length) {
          out.messages = norm2.messages;
          out.source = 'captured';
          out.session = norm2.session;
          if (!out.title && norm2.session.title) out.title = norm2.session.title;
          out.incomplete = !found.info.complete;
        }
      }
    }

    // 3) 流式回复补齐
    // History and DOM take priority over partial streaming captures.

    // 4) DOM 兜底
    var domAllowed = ctx.domFallback && (!id || id === ctx.currentSessionId);
    if ((!out.messages.length || out.incomplete || ctx.autoScroll) && domAllowed) {
      var restoreScroll = null;
      var scroller = ctx.autoScroll ? findScroller() : null;
      if (scroller) {
        var origTop = scroller.scrollTop;
        restoreScroll = function () { try { scroller.scrollTop = origTop; } catch (e) { /* ignore */ } };
      }

      var dom = null;
      var plain = null;
      // 先按当前页面提取一次，作为「绝不比这更差」的基准
      try { plain = extractDom(); } catch (e) { plain = null; }

      if (ctx.autoScroll) {
        // 勾了「滚动加载更早消息」才做边滚边收集；收集结果不如单屏就丢弃
        try { dom = await collectByScrolling(ctx); } catch (e) { ctx.note('滚动收集失败：' + (e && e.message), 'warn'); }
        if (!dom || !dom.length || (plain && dom.length < plain.length)) {
          if (dom && plain && dom.length < plain.length) {
            ctx.note('滚动收集反而不全（' + dom.length + ' < ' + plain.length + '），改用单屏结果', 'warn');
          }
          dom = plain;
        }
      } else {
        dom = plain;
      }
      if (restoreScroll) restoreScroll();
      dom = dom || [];
      if (ctx.includeMeta === false) dom = stripMeta(dom);
      if (dom.length > out.messages.length) {
        out.messages = dom;
        out.source = 'dom';
        out.incomplete = true;
        out.dom_warning = '接口不可用，内容取自页面 DOM 文本：长对话可能只渲染了一部分，且会丢 Markdown 格式与思考过程';
        var rounds = dom.filter(function (m) { return m.role === 'user'; }).length;
        ctx.note('回退到 DOM 文本（' + dom.length + ' 条 / ' + rounds + ' 轮提问，策略：' +
          ((lastDomDiagnostics && lastDomDiagnostics.strategy) || '滚动收集') + '），可能不完整', 'warn');
      } else if (!out.messages.length) {
        var diag = lastDomDiagnostics || {};
        ctx.note('页面正文提取结果：' + ((diag.tried || []).join('；') || '（没有执行）'), 'error');
        ctx.note('这次导出是空的，没有生成文件。把这个对话往上滚一遍、确认正文显示在屏幕上再试；' +
          '如果页面上明明有内容还是空，请点面板下方的「页面结构体检」把结果发我', 'error');
      }
    } else if (!out.messages.length && !domAllowed) {
      // DOM 兜底根本没被允许执行 —— 这种情况以前是静默的，很容易被误判成「页面抓不到」
      var why = !ctx.domFallback
        ? 'DOM 兜底被关掉了（勾上「DOM 兜底」再试）'
        : '只能对当前打开的会话做 DOM 兜底，这个会话（' + (id || '未知') + '）不是当前页面';
      ctx.note('没有做 DOM 兜底：' + why, 'error');
    }

    // Recheck captures after scrolling: earlier history may only have arrived now.
    (ctx.records || []).forEach(function(rec) {
      if (rec.kind !== 'history' || recordSessionId(rec) !== id || !id) return;
      var payload = rec.response_json;
      if (!payload && rec.response_text) { try {payload = JSON.parse(rec.response_text);} catch(e) {} }
      if (payload) timeCandidates = timeCandidates.concat(normalizeHistory(payload, id, ctx).messages);
    });
    timeCandidates = timeCandidates.concat(out.messages);
    attachTimes(out.messages, timeCandidates);
    var availableTimes = timeCandidates.filter(function(m){return !!m.inserted_at_iso;}).length;
    var matchedTimes = out.messages.filter(function(m){return !!m.inserted_at_iso;}).length;
    ctx.note('发言时间：' + matchedTimes + '/' + out.messages.length + ' 条已获取；' +
      (availableTimes ? '历史数据含时间，未匹配项不填时间' : '本次可读取的历史数据没有可用消息时间，页面正文无法补出时间'),
      matchedTimes ? 'info' : 'warn');

    if (!out.messages.length) appendCompletionTurns(out, ctx.records, id, ctx, ctx.note);
    if (out.messages.length && out.messages[0].role !== 'user') {
      out.incomplete = true;
      ctx.note('⚠ 第一条不是用户提问，可能遗漏会话开头；导出的轮次仅从已提取内容起算', 'warn');
    }
    if (!out.title) out.title = sessionTitle(ref, out.messages);
    if (!out.messages.length) out.incomplete = true;
    out.message_count = out.messages.length;
    out.first_at = out.messages.length ? out.messages[0].inserted_at_iso || null : null;
    out.last_at = out.messages.length ? out.messages[out.messages.length - 1].inserted_at_iso || null : null;

    if (ctx.includeMeta === false) {
      // 纯聊天记录模式下会话对象是精简的，没有 message_count 字段，这里补一个给日志 / 摘要用
      var lean = leanSession(out);
      lean.message_count = out.message_count;
      return lean;
    }
    return out;
  }

  /* -------------------------------------------------------------- 排版 */

  function pickFormat(value) {
    return FORMATS.indexOf(value) === -1 ? 'chat' : value;
  }

  function formatOne(session, opts) {
    if (!window.DSExportFormat) return null;   // 没有排版脚本就老实只给 JSON，不猜格式
    return window.DSExportFormat.formatSession(session, {
      mode: opts.mode,
      maxChars: opts.maxChars
    });
  }

  /**
   * 导出方式：chat = 只要聊天记录（默认），json = 完整 JSON，both = 两个都要。
   * chat 模式下会把诊断日志、原始接口数据、原始消息对象全部丢掉 ——
   * 那些 `inserted_at` / `duration_ms` 之类的元数据正是让人以为「混进了接口代码」的东西。
   */
  var EXPORTS = ['chat', 'json', 'both'];

  function pickExports(value) {
    return EXPORTS.indexOf(value) === -1 ? 'chat' : value;
  }

  /** 导出的文本放在 text 字段（顶层与每个会话各一份），顺手统计省了多少字 */
  function attachText(data, opts) {
    if (opts.mode === false) return;

    var totalChars = 0;
    var rawChars = 0;
    var truncated = false;
    var speakers = {};

    data.sessions.forEach(function (s) {
      var one = formatOne(s, opts);
      if (!one) return;
      s.text = one.text;
      s.text_format = one.format;
      s.text_chars = one.chars;
      if (one.truncated) s.text_truncated = true;
      totalChars += one.chars;
      rawChars += (s.messages || []).reduce(function (sum, m) { return sum + String(m.content || '').length; }, 0);
      if (one.truncated) truncated = true;
      if (one.speakers) {
        Object.keys(one.speakers).forEach(function (k) {
          if (speakers[k] === undefined) speakers[k] = one.speakers[k];
        });
      }
    });

    data.text_format = opts.mode;
    data.text_chars = totalChars;
    data.text_source_chars = rawChars;
    data.speakers = speakers;
    if (truncated) data.text_truncated = true;

    if (window.DSExportFormat) {
      data.text = data.sessions.length === 1
        ? (data.sessions[0].text || '')
        : window.DSExportFormat.formatSessions(data.sessions, { mode: opts.mode, maxChars: opts.maxChars }).text;
    }
  }

  var LEAN_KEEP = { chat_session_id: 1, title: 1, messages: 1 };

  /**
   * 「只要聊天记录」时的会话对象：去掉 url / source / api / first_at / last_at / dom_warning 之类
   * —— 文件里除了标题和正文，不该再有接口味道的字段。
   */
  function leanSession(session) {
    var out = {};
    Object.keys(session).forEach(function (k) {
      if (LEAN_KEEP[k]) out[k] = session[k];
    });
    return out;
  }

  /* -------------------------------------------------------------- 主流程 */

  function sessionIdFromLocation() {
    var m = (window.location.pathname || '').match(/\/a\/chat\/s\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /**
   * @param {Object} opts
   * @param {'current'|'all'} opts.scope
   * @param {Array} opts.records          页面采集到的 API 记录
   * @param {boolean} opts.includeRaw     是否附带原始消息对象
   * @param {boolean} opts.includeCapture 是否附带原始 API 采集记录
   * @param {boolean} opts.includeThinking 是否附带思考过程
   * @param {boolean} opts.domFallback    接口失败时是否用 DOM 兜底
   * @param {'chat'|'markdown'|'text'|false} opts.mode  导出文本的排版（false 只要 JSON 结构）
   * @param {'chat'|'json'|'both'} opts.exports  导出方式：chat = 只要聊天记录（默认），json = 完整 JSON，both = 两个都要
   * @param {number} opts.maxChars        单个会话文本的字数上限（0 / 不传 = 不截断）
   * @param {Function} opts.onLog         (level, message) => void
   */
  async function runExport(opts) {
    opts = opts || {};
    var startedAt = Date.now();
    var textOpts = {
      mode: opts.mode === false ? false : pickFormat(opts.mode),
      maxChars: Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0
    };
    var logs = [];
    var warnings = [];
    var note = function (message, level) {
      var lv = level || 'info';
      logs.push({ at: new Date().toISOString(), level: lv, message: message });
      if (lv === 'warn' || lv === 'error') warnings.push(message);
      if (typeof opts.onLog === 'function') {
        try { opts.onLog(lv, message); } catch (e) { /* ignore */ }
      }
    };

    var records = Array.isArray(opts.records) ? opts.records : [];
    var exportMode = pickExports(opts.exports);
    var wantChat = exportMode === 'chat' || exportMode === 'both';
    var wantJson = exportMode === 'json' || exportMode === 'both';

    // 只要聊天记录时，原始字段一律不取：文件里就不该出现接口/元数据
    var includeRaw = wantJson && opts.includeRaw !== false;
    var includeCapture = wantJson && opts.includeCapture !== false;
    // 聊天记录里永远不要思考过程；只有导完整 JSON 时才可能带上
    var includeThinking = wantJson && (opts.exports === 'json' ? opts.includeThinking !== false : opts.includeThinking === true);

    var ctx = {
      records: records,
      hasToken: hasAuthToken(),
      currentSessionId: sessionIdFromLocation(),
      includeRaw: includeRaw,
      includeMeta: wantJson,
      includeThinking: includeThinking,
      domFallback: opts.domFallback !== false,
      // 虚拟滚动：导出前边滚边收集更早的历史。默认关闭 —— 它依赖页面结构，容易反而更少，
      // 所以交给用户在面板里显式勾选，绝不悄悄影响默认导出结果。
      autoScroll: opts.autoScroll === true,
      note: note
    };

    learnHeaders(records);

    note('已登录 token：' + (ctx.hasToken ? '找到' : '未找到（只能靠页面采集数据）'),
      ctx.hasToken ? 'info' : 'warn');
    note('页面已捕获 ' + records.length + ' 条相关接口记录', 'info');

    var refs;
    if (opts.scope === 'all') {
      refs = await collectRefs(ctx);
      note('待导出会话数：' + refs.length, refs.length ? 'info' : 'warn');
      if (!refs.length) {
        throw new Error('没有找到任何会话。请先刷新页面、展开侧边栏滚到底，再点导出。');
      }
    } else {
      refs = [{ id: ctx.currentSessionId, title: domTitle() }];
      note('当前会话：' + (ctx.currentSessionId || '（新对话，尚未保存）'), 'info');
    }

    var sessions = [];
    var builtSessions = [];
    for (var i = 0; i < refs.length; i++) {
      var built = await buildSession(refs[i], ctx);
      // 标签 / 计数 / 来源这些运行时信息留在 full 上，纯聊天记录只取干净的那份
      var full = { title: built.title, chat_session_id: built.chat_session_id, message_count: built.message_count, source: built.source, incomplete: built.incomplete };
      sessions.push(full);
      builtSessions.push(built);
      note('[' + (i + 1) + '/' + refs.length + '] ' +
        (full.title || full.chat_session_id || '当前会话') +
        ' — ' + full.message_count + ' 条消息（' + (full.source || '空') + (full.incomplete ? '，不完整' : '') + '）',
        full.message_count && !full.incomplete ? 'ok' : 'warn');
    }

    var usedSources = {};
    sessions.forEach(function (s) { usedSources[s.source || 'none'] = true; });

    var incomplete = sessions.some(function (s) { return s.incomplete; });
    var totalMessages = sessions.reduce(function (sum, s) { return sum + (s.message_count || 0); }, 0);

    // 一条消息都没抓到：别写文件，也别让调用方以为成功了
    if (!totalMessages && opts.allowEmpty !== true) {
      var emptyErr = new Error('一条消息都没抓到，没有生成文件。先把对话在页面上滚一遍、确认内容都显示出来了再试');
      emptyErr.empty = true;
      throw emptyErr;
    }

    var data = wantJson
      ? {
        schema: SCHEMA,
        exported_at: nowIso(),
        exporter: {
          name: 'deepseek-chat-exporter',
          version: VERSION,
          url: 'https://chat.deepseek.com'
        },
        scope: opts.scope === 'all' ? 'all' : 'current',
        export_mode: exportMode,
        options: {
          include_raw_message: includeRaw,
          include_thinking: includeThinking,
          dom_fallback: ctx.domFallback,
          text_format: textOpts.mode === false ? null : textOpts.mode,
          text_max_chars: textOpts.maxChars || null
        },
        session_count: sessions.length,
        message_count: sessions.reduce(function (sum, s) { return sum + s.message_count; }, 0),
        sources: Object.keys(usedSources),
        incomplete: incomplete,
        warnings: warnings,
        sessions: builtSessions,
        diagnostics: {
          token_found: ctx.hasToken,
          captured_records: records.length,
          replay_headers_learned: !!replayHeaders,
          duration_ms: Date.now() - startedAt,
          logs: logs
        }
      }
      // 只要聊天记录：整个对象就只剩「会话 + 正文」，一个接口字段都没有
      : {
        export_mode: 'chat',
        exported_at: nowIso(),
        session_count: sessions.length,
        sessions: builtSessions,
        text_format: textOpts.mode === false ? null : textOpts.mode
      };

    // 原始接口数据：只保留与本次导出会话相关的 history / completion。
    // 会话列表（侧边栏）这类和对话内容无关的数据不进文件 —— 之前就是它把侧边栏标题带出去的。
    if (includeCapture) {
      var ids = {};
      sessions.forEach(function (s) { if (s.chat_session_id) ids[s.chat_session_id] = true; });

      var kept = [];
      var skipped = 0;
      records.forEach(function (r) {
        if (r.kind !== 'history' && r.kind !== 'completion') { skipped++; return; }
        var recId = recordSessionId(r);
        if (recId && !ids[recId]) { skipped++; return; }
        kept.push({
          id: r.id,
          kind: r.kind,
          method: r.method,
          url: r.url,
          // Request headers can contain credentials; never export them.
          request_headers: undefined,
          request_body: r.request_body,
          http_status: r.http_status,
          captured_at: r.captured_at,
          finished_at: r.finished_at,
          response_json: r.response_json,
          response_text: r.response_json ? undefined : r.response_text,
          sse_text: r.sse_text,
          events: r.events
        });
      });

      data.raw_capture = kept;
      data.diagnostics.capture_kept = kept.length;
      data.diagnostics.capture_skipped = skipped;
    }

    // 顺手排好版：会话对象里直接带一份「发言人1：内容」的文本，复制粘贴就能用
    attachText(data, textOpts);
    if (textOpts.mode !== false && data.text_chars) {
      note('已排版 ' + (textOpts.mode || 'chat') + ' 文本：' + data.text_chars.toLocaleString() +
        ' 字符（原文 ' + data.text_source_chars.toLocaleString() + ' 字符）', 'info');
    }

    var base = opts.scope === 'all'
      ? 'deepseek-all'
      : 'deepseek-' + slug(sessions[0] && (sessions[0].title || sessions[0].chat_session_id), 60);
    var stamp = stampForFilename();
    var ext = {
      chat: { ext: '.md', mime: 'text/markdown' },
      json: { ext: '.json', mime: 'application/json' },
      both: { ext: '.json', mime: 'application/json' }
    }[exportMode];

    return {
      data: data,
      exportMode: exportMode,
      wantChat: wantChat,
      wantJson: wantJson,
      filename: base + '-' + stamp + ext.ext,
      mime: ext.mime,
      jsonFilename: base + '-' + stamp + '.json',
      textFilename: base + '-' + stamp + '.md',
      text: data.text || '',
      summary: {
        sessions: sessions.length,
        messages: data.sessions.reduce(function (sum, s) { return sum + (s.messages || []).length; }, 0),
        sources: data.sources || Object.keys(usedSources),
        incomplete: incomplete,
        export_mode: exportMode,
        text_format: textOpts.mode === false ? null : textOpts.mode,
        text_chars: data.text_chars || 0,
        text_truncated: !!data.text_truncated,
        warnings: warnings.slice(0, 10)
      }
    };
  }

  window.DSExportCore = {
    version: VERSION,
    sessionIdFromLocation: sessionIdFromLocation,
    hasAuthToken: hasAuthToken,
    readToken: readToken,
    runExport: runExport,
    formatSession: function (session, formatOpts) { return formatOne(session, formatOpts || {}); },
    _internals: {
      attachTimes: attachTimes,
      pickMessages: pickMessages,
      historyInfo: historyInfo,
      mapMessage: mapMessage,
      normalizeHistory: normalizeHistory,
      reconstructCompletion: reconstructCompletion,
      extractDom: extractDom,
      extractDomLoose: extractDomLoose,
      extractRawDump: extractRawDump,
      lastDomDiagnostics: function () { return lastDomDiagnostics; },
      pickFormat: pickFormat,
      pickExports: pickExports,
      walkSessionObjects: walkSessionObjects,
      stripCacheParams: stripCacheParams,
      coerceToken: coerceToken,
      recordSessionId: recordSessionId,
      slug: slug
    }
  };
})();
