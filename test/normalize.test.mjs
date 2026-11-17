/* 在 Node 里跑导出核心的归一化 / 组装逻辑（不依赖浏览器页面）。
 * 用法：node test/normalize.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/exporter.js', import.meta.url), 'utf8');

/* ---------------------------------------------------------------- 假环境 */

function makeEnv(overrides = {}) {
  const store = Object.assign({}, overrides.store || {
    user_token: JSON.stringify({ value: 'fake-token-value-123456' })
  });

  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i) => Object.keys(store)[i]
  };

  const document = {
    title: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    body: null,
    documentElement: null
  };

  const window = {
    localStorage,
    location: { pathname: overrides.pathname || '/a/chat/s/sess-0001-abcd', origin: 'https://chat.deepseek.com' }
  };

  const ctx = {
    window,
    document,
    localStorage,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    console,
    setTimeout,
    clearTimeout,
    URL,
    fetch: overrides.fetch,
    location: window.location
  };

  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'exporter.js' });
  return { ctx, core: ctx.window.DSExportCore, store };
}

/* --------------------------------------------------------------- 假数据 */

const historyPayload = {
  code: 0,
  msg: '',
  data: {
    biz_data: {
      chat_session: {
        id: 'sess-0001-abcd',
        title: '测试会话',
        model_type: 'default',
        inserted_at: 1767225600,
        updated_at: 1767225700
      },
      chat_messages: [
        { message_id: 1, role: 'USER', content: '你好', inserted_at: 1767225600, status: 'FINISHED', files: [] },
        {
          message_id: 2,
          role: 'ASSISTANT',
          content: '你好，我是 DeepSeek。',
          thinking_content: '用户在打招呼',
          thinking_elapsed_secs: 3,
          status: 'FINISHED',
          inserted_at: 1767225610,
          accumulated_token_usage: 42,
          files: []
        }
      ]
    }
  }
};

const sessionListPayload = {
  code: 0,
  data: {
    biz_data: {
      chat_sessions: [
        { id: 'sess-aaaa-1111', title: '会话 A', updated_at: 1767225700 },
        { id: 'sess-bbbb-2222', title: '会话 B', updated_at: 1767225600 }
      ]
    }
  }
};

// 真实环境里「带 cache_version 请求」拿到的增量响应：消息为空，但 current_message_id 仍指向最后一条
const deltaPayload = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      chat_session: {
        id: 'sess-0001-abcd',
        title: '测试会话',
        model_type: 'default',
        current_message_id: 2,
        version: 194,
        updated_at: 1792255931.857
      },
      chat_messages: [],
      cache_control: { some: 'field' }
    }
  }
};

/* ------------------------------------------------------------------ 测试 */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('coerceToken 能解出 {value:...} 里的 token', () => {
  const { core } = makeEnv();
  const t = core._internals.coerceToken('{"value":"abc123def456ghi789"}');
  assert.equal(t, 'abc123def456ghi789');
});

test('coerceToken 能识别裸 JWT 字符串', () => {
  const { core } = makeEnv();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop';
  assert.equal(core._internals.coerceToken(jwt), jwt);
});

test('coerceToken 拒绝空值 / 带空格的垃圾', () => {
  const { core } = makeEnv();
  assert.equal(core._internals.coerceToken(''), null);
  assert.equal(core._internals.coerceToken('not a token at all'), null);
});

test('readToken 能从 localStorage 里找到 token', () => {
  const { core } = makeEnv();
  assert.equal(core.hasAuthToken(), true);
  assert.equal(core.readToken(), 'fake-token-value-123456');
});

test('pickMessages 能钻进 data.biz_data 取出 chat_messages', () => {
  const { core } = makeEnv();
  const picked = core._internals.pickMessages(historyPayload);
  assert.equal(picked.messages.length, 2);
  assert.equal(picked.container.chat_session.title, '测试会话');
});

test('pickMessages 对空会话也返回结构', () => {
  const { core } = makeEnv();
  const picked = core._internals.pickMessages({ data: { biz_data: { chat_messages: [] } } });
  assert.equal(picked.messages.length, 0);
  assert.notEqual(picked.container, null);
});

test('normalizeHistory 角色 / 思考过程 / 时间戳都正确', () => {
  const { core } = makeEnv();
  const out = core._internals.normalizeHistory(historyPayload, 'sess-0001-abcd', {
    includeThinking: true,
    includeRaw: true
  });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.messages[1].role, 'assistant');
  assert.equal(out.messages[1].content, '你好，我是 DeepSeek。');
  assert.equal(out.messages[1].thinking, '用户在打招呼');
  assert.equal(out.messages[1].inserted_at_iso, new Date(1767225610000).toISOString());
  assert.equal(out.messages[1].token_usage, 42);
  assert.ok(out.messages[1].raw, 'includeRaw 时应保留原始对象');
  assert.equal(out.session.title, '测试会话');
});

test('normalizeHistory 关掉 includeRaw 就不带 raw', () => {
  const { core } = makeEnv();
  const out = core._internals.normalizeHistory(historyPayload, null, { includeRaw: false, includeThinking: false });
  assert.equal('raw' in out.messages[0], false);
  assert.equal('thinking' in out.messages[1], false);
});

test('reconstructCompletion 能从 SSE 事件拼回正文与思考', () => {
  const { core } = makeEnv();
  const rebuilt = core._internals.reconstructCompletion({
    events: [
      { v: '先想一下', p: 'response/thinking_content' },
      { v: '你好', p: 'response/content' },
      { v: '世界', p: 'response/content' }
    ]
  });
  assert.equal(rebuilt.thinking, '先想一下');
  assert.equal(rebuilt.content, '你好世界');
});

test('walkSessionObjects 能扒出会话列表', () => {
  const { core } = makeEnv();
  const found = [];
  core._internals.walkSessionObjects(sessionListPayload, found, 0);
  assert.equal(found.length, 2);
  assert.equal(found[0].title, '会话 A');
});

test('slug 处理文件名里的非法字符', () => {
  const { core } = makeEnv();
  assert.equal(core._internals.slug('a/b:c*d?'), 'a b c d');
});

test('runExport(current) 端到端产出合法结构', async () => {
  const calls = [];
  const env = makeEnv({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (/history_messages/.test(url)) {
        return { ok: true, status: 200, text: async () => JSON.stringify(historyPayload) };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    }
  });

  const result = await env.core.runExport({
    scope: 'current',
    records: [],
    exports: 'both',          // 要完整 JSON（含 raw_capture / diagnostics）
    includeRaw: true,
    includeThinking: true,
    includeCapture: true,
    domFallback: true,
    onLog: () => {}
  });

  assert.equal(result.data.schema, 'deepseek-chat-export/v1');
  assert.equal(result.data.session_count, 1);
  assert.equal(result.data.message_count, 2);
  assert.equal(result.data.sessions[0].source, 'api');
  assert.equal(result.data.sessions[0].chat_session_id, 'sess-0001-abcd');
  assert.ok(Array.isArray(result.data.raw_capture));
  assert.match(result.filename, /^deepseek-.*\.json$/);
  assert.ok(calls.some((c) => /history_messages/.test(c.url)));
  // 请求必须带上 Bearer token
  const historyCall = calls.find((c) => /history_messages/.test(c.url));
  assert.equal(historyCall.init.headers.authorization, 'Bearer fake-token-value-123456');
});

test('一条消息都没抓到时直接报错，不产出空文件', async () => {
  const env = makeEnv({
    fetch: async () => ({ ok: false, status: 401, text: async () => '{"code":401}' })
  });
  const logs = [];
  await assert.rejects(
    () => env.core.runExport({
      scope: 'current',
      records: [],
      exports: 'json',
      domFallback: true,
      onLog: (lv, m) => logs.push({ lv, m })
    }),
    /一条消息都没抓到/
  );
  // 必须把「为什么抓不到」说清楚，不能静默
  assert.ok(
    logs.some((l) => /页面正文提取结果|一条消息都没抓到/.test(l.m)),
    '日志里应该说清楚为什么抓不到：' + JSON.stringify(logs.map((l) => l.m))
  );
  // 每一层策略都要有交代
  var joined = logs.map((l) => l.m).join('\n');
  assert.ok(/主提取|宽松兜底|直接提取/.test(joined), '应该报告各层策略的结果：\n' + joined);
});

test('allowEmpty 可以显式允许空结果（给调试用）', async () => {
  const env = makeEnv({
    fetch: async () => ({ ok: false, status: 401, text: async () => '{"code":401}' })
  });
  const result = await env.core.runExport({
    scope: 'current', records: [], exports: 'json', domFallback: true, allowEmpty: true, onLog: () => {}
  });
  assert.equal(result.data.sessions[0].message_count, 0);
});

test('runExport(all) 会话列表为空时报可读错误', async () => {
  const env = makeEnv({
    fetch: async () => ({ ok: false, status: 500, text: async () => '{}' })
  });
  await assert.rejects(
    () => env.core.runExport({ scope: 'all', records: [], onLog: () => {} }),
    /没有找到任何会话/
  );
});

test('runExport 能用采集到的原始响应（不依赖接口）', async () => {
  const env = makeEnv({
    fetch: async () => ({ ok: false, status: 500, text: async () => '{}' })
  });
  const records = [
    {
      id: 1,
      kind: 'history',
      method: 'GET',
      url: 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=sess-0001-abcd',
      request_headers: { authorization: 'Bearer fake-token-value-123456' },
      response_json: historyPayload,
      captured_at: Date.now()
    }
  ];
  const result = await env.core.runExport({
    scope: 'current',
    records,
    exports: 'both',
    domFallback: false,
    onLog: () => {}
  });
  assert.equal(result.data.sessions[0].source, 'captured');
  assert.equal(result.data.message_count, 2);
  assert.equal(result.data.raw_capture.length, 1);
});

/* ------------------------------------------------- 回归：缓存增量 / 侧边栏 */

test('historyInfo 能认出「缓存增量」空响应', () => {
  const { core } = makeEnv();
  const info = core._internals.historyInfo(deltaPayload);
  assert.equal(info.messages.length, 0);
  assert.equal(info.complete, false);
  assert.equal(info.target, 2);
});

test('historyInfo 对全量响应的 complete 判定', () => {
  const { core } = makeEnv();
  const full = JSON.parse(JSON.stringify(historyPayload));
  full.data.biz_data.chat_session.current_message_id = 2;
  const info = core._internals.historyInfo(full);
  assert.equal(info.messages.length, 2);
  assert.equal(info.complete, true);
});

test('stripCacheParams 去掉 cache_version / cache_reset_at', () => {
  const { core } = makeEnv();
  const out = core._internals.stripCacheParams(
    '/api/v0/chat/history_messages?chat_session_id=abc&cache_version=194&cache_reset_at=1792235478'
  );
  assert.equal(out, '/api/v0/chat/history_messages?chat_session_id=abc');
});

test('回放请求必须去掉缓存参数，否则只拿到空增量', async () => {
  const seen = [];
  const env = makeEnv({
    fetch: async (url) => {
      seen.push(String(url));
      if (/cache_version=(?!0)/.test(String(url))) {
        return { ok: true, status: 200, text: async () => JSON.stringify(deltaPayload) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(historyPayload) };
    }
  });

  const records = [
    {
      id: 9,
      kind: 'history',
      method: 'GET',
      url: '/api/v0/chat/history_messages?chat_session_id=sess-0001-abcd&cache_version=194&cache_reset_at=1792235478',
      request_headers: { authorization: 'Bearer old-school', 'x-client-version': '2.5.0' },
      response_json: deltaPayload,
      captured_at: Date.now()
    }
  ];

  const result = await env.core.runExport({ scope: 'current', records, exports: 'both', onLog: () => {} });
  const session = result.data.sessions[0];
  assert.equal(session.source, 'api');
  assert.equal(session.messages.length, 2);
  assert.equal(session.incomplete, false);
  assert.ok(seen.every((u) => !/cache_version=194/.test(u)), '还在用带缓存参数的 URL: ' + seen.join(' | '));
});

test('接口只给增量时标记 incomplete 并产生警告', async () => {
  const env = makeEnv({
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(deltaPayload) })
  });
  const result = await env.core.runExport({
    scope: 'current',
    records: [],
    exports: 'both',
    domFallback: false,
    allowEmpty: true,     // 只给空增量、又没有 DOM 可兜底：这里只想验证「不完整」标记
    onLog: () => {}
  });
  assert.equal(result.data.sessions[0].incomplete, true);
  assert.ok(result.data.incomplete, '顶层 incomplete 也要为 true');
  assert.ok(result.data.warnings.length > 0);
});

test('raw_capture 不带会话列表（侧边栏）数据', async () => {
  const env = makeEnv({
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(historyPayload) })
  });

  const records = [
    {
      id: 1,
      kind: 'session_list',
      method: 'GET',
      url: '/api/v0/chat_session/fetch_page?lte_cursor.pinned=false',
      request_headers: { authorization: 'Bearer token' },
      response_json: sessionListPayload,
      captured_at: Date.now()
    },
    {
      id: 2,
      kind: 'history',
      method: 'GET',
      url: '/api/v0/chat/history_messages?chat_session_id=sess-0001-abcd',
      request_headers: { authorization: 'Bearer token' },
      response_json: historyPayload,
      captured_at: Date.now()
    }
  ];

  const result = await env.core.runExport({ scope: 'current', records, exports: 'both', includeCapture: true, onLog: () => {} });
  const kinds = result.data.raw_capture.map((r) => r.kind);
  assert.equal(kinds.join(','), 'history');
  assert.equal(JSON.stringify(result.data.raw_capture).includes('会话 A'), false);
  assert.equal(result.data.diagnostics.capture_skipped, 1);
});

/* ------------------------------------------------------------------ 执行 */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (err && err.message));
  }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' 通过');
process.exit(failed ? 1 : 0);
