/* 在 Node 里验证「排版」模块：发言人编号、噪声清洗、代码块保护、截断。
 * 用法：node test/format.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/format.js', import.meta.url), 'utf8');

function loadFormat() {
  const sandbox = {};
  sandbox.window = sandbox;      // 浏览器里 window 就是全局对象；脚本靠 window.DSExportFormat 暴露接口
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'format.js' });
  return sandbox.DSExportFormat;
}

const F = loadFormat();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* --------------------------------------------------------------- 清洗 */

test('助手回复里的「已深度思考」「已搜索到 N 个网页」被去掉', () => {
  const content = [
    '已深度思考（用时 12 秒）',
    '',
    '> 用户想要一个排序思路',
    '',
    '已搜索到 23 个网页',
    '> [1] 排序算法 - Wikipedia',
    '> [2] quicksort - 菜鸟教程',
    '',
    '冒泡排序的核心是相邻两两比较。'
  ].join('\n');

  const out = F._internals.cleanContent({ role: 'assistant', content }, 'chat');
  // 开头的引用块会收成普通段落（语义内容），但思考提示和搜索列表必须消失
  assert.equal(out, '用户想要一个排序思路\n\n冒泡排序的核心是相邻两两比较。');
  assert.ok(!out.includes('已深度思考'));
  assert.ok(!out.includes('已搜索到'));
  assert.ok(!out.includes('菜鸟教程'));
});

test('搜索列表夹在正文中间时也整块去掉，且不影响前后正文', () => {
  const content = [
    '第一段。',
    '',
    '已搜索到 5 个网页',
    '> [1] 甲',
    '> [2] 乙',
    '> [3] 丙',
    '',
    '第二段。'
  ].join('\n');
  assert.equal(F._internals.cleanContent({ content }, 'chat'), '第一段。\n\n第二段。');
});

test('citation 与网页角标被清掉', () => {
  const out = F._internals.cleanContent(
    { content: '根据资料[citation:3]和[citation:12]，答案是 42[1]。' },
    'chat'
  );
  assert.equal(out, '根据资料和，答案是 42。');
});

test('代码块里的内容一个字都不动（不删角标、不改格式）', () => {
  const content = [
    '看这段：',
    '',
    '```python',
    '# 已搜索到 3 个网页   <- 注释，不能被当成噪声删掉',
    'arr[1] = arr[0]',
    'print("[citation:1]")',
    '```',
    '',
    '完。'
  ].join('\n');

  const out = F._internals.cleanContent({ content }, 'chat');
  assert.ok(out.includes('已搜索到 3 个网页   <- 注释，不能被当成噪声删掉'), '代码块被误清洗：\n' + out);
  assert.ok(out.includes('arr[1] = arr[0]'), '代码块里的 [1] 被误删：\n' + out);
  assert.ok(out.includes('print("[citation:1]")'), '代码块里的 citation 被误删：\n' + out);
  assert.ok(!out.includes('```'), 'chat 模式不应该留 ``` 围栏');
});

test('markdown 模式保留代码块围栏', () => {
  const out = F._internals.cleanContent({ content: '```js\nlet a = 1;\n```' }, 'markdown');
  assert.equal(out, '```\nlet a = 1;\n```');
});

test('正文已有链接时，结尾单独的引用链接列表整行丢掉', () => {
  const content = [
    '参考了[原文](https://example.com/a)里的说法。',
    '',
    '[来源1](https://example.com/b)',
    '[来源2](https://example.com/c)'
  ].join('\n');
  const out = F._internals.cleanContent({ content }, 'chat');
  assert.equal(out, '参考了[原文](https://example.com/a)里的说法。');
});

test('正文没有链接时，结尾的链接列表保留（那是唯一来源）', () => {
  const content = '结论见下文。\n\n[来源1](https://example.com/b)';
  const out = F._internals.cleanContent({ content }, 'chat');
  assert.ok(out.includes('[来源1](https://example.com/b)'));
});

test('「已思考（用时N秒）」这种新文案也会被去掉', () => {
  const out = F._internals.cleanContent({ content: '已思考（用时 11 秒）\n\n这是正文。' }, 'chat');
  assert.equal(out, '这是正文。');
});

test('「已停止生成」「生成中」这类状态行被去掉', () => {
  const out = F._internals.cleanContent({ content: '正在生成\n\n好的，继续。\n已停止生成' }, 'chat');
  assert.equal(out, '好的，继续。');
});

test('text 模式去掉 Markdown 记号', () => {
  const out = F._internals.cleanContent(
    { content: '## 标题\n\n**重点**：`inline` 代码\n\n- 一\n- 二' },
    'text'
  );
  assert.equal(out, '标题\n\n重点：`inline` 代码\n\n- 一\n- 二');
});

test('没闭合的代码块不会吞掉后面内容', () => {
  const out = F._internals.cleanContent({ content: '前面\n```js\n未闭合的一行' }, 'chat');
  assert.ok(out.includes('未闭合的一行'), out);
  assert.ok(out.includes('前面'), out);
});

/* ---------------------------------------------------------------- 排版 */

const session = {
  title: '排序算法讨论',
  messages: [
    { role: 'user', content: '帮我讲讲冒泡排序' },
    {
      role: 'assistant',
      content: '已深度思考（用时 5 秒）\n\n冒泡排序：相邻两两比较，大的往后换。',
      thinking: '这段思考过程不应该出现在文本里'
    },
    { role: 'user', content: '那快排呢？' },
    { role: 'assistant', content: '快排：选一个基准，分成左右两半递归。' },
    { role: 'assistant', content: '补充：时间复杂度 O(n log n)。' }
  ]
};

test('chat 模式排成「发言人1：内容」', () => {
  const out = F.formatSession(session, { mode: 'chat' });
  const lines = out.text.split('\n');
  assert.equal(lines[0], '排序算法讨论', '第一行是会话标题，不配下划线装饰');
  assert.equal(lines[1], '', '标题后直接空一行接正文：' + JSON.stringify(lines[1]));
  assert.ok(out.text.includes('发言人1（我）：帮我讲讲冒泡排序'), out.text);
  assert.ok(out.text.includes('发言人2（DeepSeek）：冒泡排序：相邻两两比较，大的往后换。'), out.text);
  assert.ok(out.text.includes('发言人1（我）：那快排呢？'), out.text);
  // 助手连续两条仍然算同一个发言人
  assert.ok(!out.text.includes('发言人3'), out.text);
  assert.equal(out.speakers.user, '我');
  assert.equal(out.speakers.assistant, 'DeepSeek');
});

test('思考过程不进入导出文本', () => {
  const out = F.formatSession(session, { mode: 'chat' });
  assert.ok(!out.text.includes('这段思考过程'));
  assert.ok(!out.text.includes('已深度思考'));
});

test('text 模式同样是发言人格式', () => {
  const out = F.formatSession(session, { mode: 'text' });
  assert.ok(out.text.includes('发言人1（我）：帮我讲讲冒泡排序'));
});

test('markdown 模式带标题、加粗人设和分隔线', () => {
  const out = F.formatSession(session, { mode: 'markdown' });
  assert.ok(out.text.startsWith('# 排序算法讨论'), out.text.slice(0, 40));
  assert.ok(out.text.includes('**我**：\n\n帮我讲讲冒泡排序'));
  assert.ok(out.text.includes('\n\n---\n\n'), '轮次之间应该有分隔线');
});

test('maxChars 截断并给出标记', () => {
  const out = F.formatSession(session, { mode: 'chat', maxChars: 60 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.includes('已截断'));
  assert.ok(out.total_chars > 60);
  // 截断只作用在正文上：标题 + 截断提示允许额外几十个字符，但不能把剩下的正文也带出来
  assert.ok(out.chars < out.total_chars, '截断后总长度应该明显变短：' + out.chars + ' vs ' + out.total_chars);
  assert.ok(!out.text.includes('那快排呢'), '截断后的文本不应该还带着后面的轮次：\n' + out.text);
});

test('没有正文的消息（空 content）不产生空发言人行', () => {
  const out = F.formatSession({
    title: 't',
    messages: [{ role: 'user', content: '  ' }, { role: 'assistant', content: '有内容' }]
  }, { mode: 'chat' });
  assert.equal((out.text.match(/发言人/g) || []).length, 1, out.text);
});

test('system 消息不进导出的聊天文本', () => {
  const out = F.formatSession({
    title: 't',
    messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '嗨' }]
  }, { mode: 'chat' });
  assert.ok(!out.text.includes('你是助手'));
  assert.ok(out.text.includes('发言人1（我）：嗨'));
});

test('多个会话拼成一份', () => {
  const out = F.formatSessions([
    { title: 'A', messages: [{ role: 'user', content: '一' }] },
    { title: 'B', messages: [{ role: 'user', content: '二' }] }
  ], { mode: 'chat' });
  assert.ok(out.text.includes('A'));
  assert.ok(out.text.includes('B'));
  assert.ok(out.text.includes('════════'));
});

/* ---------------------------------------------------------- 与导出核心对接 */

const exporterSource = fs.readFileSync(new URL('../src/exporter.js', import.meta.url), 'utf8');

function makeCore() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (k === 'user_token' ? JSON.stringify({ value: 'fake-token-value-123456' }) : null)
  };
  sandbox.location = { pathname: '/a/chat/s/sess-0001-abcd', origin: 'https://chat.deepseek.com' };
  sandbox.document = { title: '', querySelector: () => null, querySelectorAll: () => [], body: null, documentElement: null };
  sandbox.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.URL = URL;
  const payload = {
    data: {
      biz_data: {
        chat_session: { id: 'sess-0001-abcd', title: '测试会话', current_message_id: 2 },
        chat_messages: [
          { message_id: 1, role: 'USER', content: '你好', inserted_at: 1767225600 },
          {
            message_id: 2,
            role: 'ASSISTANT',
            content: '已搜索到 3 个网页\n> [1] 甲\n\n你好，我是 DeepSeek。',
            thinking_content: '内部思考',
            inserted_at: 1767225610
          }
        ]
      }
    }
  };
  sandbox.fetch = async (url) => {
    if (/history_messages/.test(String(url))) {
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'format.js' });
  vm.runInContext(exporterSource, sandbox, { filename: 'exporter.js' });
  return sandbox.window.DSExportCore;
}

test('导出结果默认带「发言人」排版的 text 字段', async () => {
  const core = makeCore();
  const result = await core.runExport({ scope: 'current', records: [], onLog: () => {} });
  const data = result.data;
  assert.equal(data.text_format, 'chat');
  assert.ok(typeof data.sessions[0].text === 'string' && data.sessions[0].text.length > 0);
  assert.ok(data.sessions[0].text.includes('发言人1（我） [2026-01-01 00:00:00 UTC]：你好'), data.sessions[0].text);
  assert.ok(data.sessions[0].text.includes('发言人2（DeepSeek） [2026-01-01 00:00:10 UTC]：'), data.sessions[0].text);
  assert.ok(!data.sessions[0].text.includes('内部思考'), '思考过程不应该进文本');
  assert.ok(!data.sessions[0].text.includes('已搜索到 3 个网页'), '搜索列表不应该进文本');
  assert.ok(data.sessions[0].text_chars > 0);
  assert.ok(data.text_source_chars > 10, '原文按 content 长度统计');
  assert.equal(data.options, undefined, '默认（只要聊天记录）连 options 都不写');
});

test('mode: markdown / text 都能选，mode:false 就不输出文本', async () => {
  const core = makeCore();
  const md = await core.runExport({ scope: 'current', records: [], exports: 'both', mode: 'markdown', onLog: () => {} });
  assert.equal(md.data.text_format, 'markdown');
  assert.ok(md.data.text.startsWith('# 测试会话'), md.data.text.slice(0, 30));
  assert.ok(md.data.text.includes('**我**：'));

  const plain = await core.runExport({ scope: 'current', records: [], exports: 'both', mode: 'text', onLog: () => {} });
  assert.equal(plain.data.text_format, 'text');

  const none = await core.runExport({ scope: 'current', records: [], exports: 'both', mode: false, onLog: () => {} });
  assert.equal('text' in none.data.sessions[0], false);
  assert.equal(none.data.options.text_format, null);
});

test('maxChars 传进导出后生效', async () => {
  const core = makeCore();
  const result = await core.runExport({ scope: 'current', records: [], exports: 'both', maxChars: 30, onLog: () => {} });
  assert.equal(result.data.text_truncated, true);
  assert.ok(result.data.text.includes('已截断'));
  assert.equal(result.summary.text_truncated, true);
});

/* ------------------------------------------------ 导出方式：只要聊天记录 */

test('默认导出（exports: chat）里没有任何接口 / 诊断字段', async () => {
  const core = makeCore();
  const result = await core.runExport({ scope: 'current', records: [], onLog: () => {} });
  const data = result.data;
  const json = JSON.stringify(data, null, 2);

  assert.equal(result.exportMode, 'chat');
  assert.equal(result.wantChat, true);
  assert.equal(result.wantJson, false);
  assert.equal(data.export_mode, 'chat');

  // 关键词一个都不许出现在文件里
  for (const word of ['diagnostics', 'raw_capture', 'duration_ms', 'message_id',
    'schema', 'exporter', 'logs', '"raw"', 'token_found']) {
    assert.ok(!json.includes(word), `默认导出里不应该有 ${word}：\n` + json.slice(0, 600));
  }
  // 但消息内容本身要在
  assert.ok(json.includes('你好，我是 DeepSeek。'));
  assert.equal(result.filename.endsWith('.md'), true, '默认产出 .md：' + result.filename);
  assert.equal(result.textFilename, result.filename);
});

test('默认导出不会再因为「要完整」而带上思考过程', async () => {
  const core = makeCore();
  const result = await core.runExport({ scope: 'current', records: [], includeThinking: true, onLog: () => {} });
  const json = JSON.stringify(result.data);
  assert.ok(!json.includes('内部思考'), '只要聊天记录时，思考过程不该出现');
});

test('exports: json 仍然是完整 JSON（字段齐全）', async () => {
  const core = makeCore();
  const result = await core.runExport({
    scope: 'current', records: [], exports: 'json',
    includeRaw: true, includeThinking: true, includeCapture: true, onLog: () => {}
  });
  const data = result.data;
  assert.equal(result.wantChat, false);
  assert.equal(result.wantJson, true);
  assert.ok(data.diagnostics, '完整 JSON 要有 diagnostics');
  assert.equal(Array.isArray(data.raw_capture), true);
  assert.ok(result.filename.endsWith('.json'));
  assert.equal(data.sessions[0].messages[1].thinking, '内部思考');
});

test('exports: both 两个都要（.md + .json）', async () => {
  const core = makeCore();
  const result = await core.runExport({ scope: 'current', records: [], exports: 'both', onLog: () => {} });
  assert.equal(result.wantChat, true);
  assert.equal(result.wantJson, true);
  assert.ok(result.text.length > 0);
  assert.ok(result.data.diagnostics);
  assert.ok(result.jsonFilename.endsWith('.json'));
  assert.ok(result.textFilename.endsWith('.md'));
  assert.notEqual(result.jsonFilename, result.textFilename);
});

test('非法 exports 值退回默认的 chat', async () => {
  const core = makeCore();
  const result = await core.runExport({ scope: 'current', records: [], exports: 'nonsense', onLog: () => {} });
  assert.equal(result.exportMode, 'chat');
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
