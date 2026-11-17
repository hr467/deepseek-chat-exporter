/* 验证「对话正文脱壳」模块（refine.js）。
 *
 * 这里专门造一份 DeepSeek 页面那种结构的 DOM：答案外面套着
 * 「思考过程 + 搜索列表 + 复制/重新生成按钮」的容器 —— 老版本会把这一整坨都当成正文。
 * 用 jsdom 跑真实 DOM，检查 refine 只留下正文。
 *
 * 用法：node test/refine.test.mjs
 * （需要 jsdom；没装就跳过，另两条测试不受影响）
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('  skip  没有安装 jsdom，跳过 DOM 相关用例');
  console.log('\n0/0 通过（已跳过）');
  process.exit(0);
}

const source = fs.readFileSync(new URL('../src/refine.js', import.meta.url), 'utf8');

function loadRefine(html) {
  // 用一个真实 origin，localStorage 才可用
  const dom = new JSDOM(html, { url: 'https://chat.deepseek.com/a/chat/s/sess-0001-abcd', pretendToBeVisual: true });
  const window = dom.window;
  window.getComputedStyle = window.getComputedStyle || (() => ({ display: 'block', visibility: 'visible' }));
  vm.createContext(window);
  vm.runInContext(source, window, { filename: 'refine.js' });
  return { window, refine: window.DSExportRefine, document: window.document };
}

/** 一条「带思考过程 + 搜索列表 + 按钮」的 DeepSeek 风格回答 */
function answer(bodyHtml, opts) {
  opts = opts || {};
  return `
  <div class="turn">
    ${opts.think !== false ? `
    <div class="ds-think-block">
      <div class="think-head">已深度思考（用时 12 秒）</div>
      <div class="think-body">用户问的是排序，我应该先讲冒泡……</div>
    </div>` : ''}
    ${opts.search !== false ? `
    <div class="search-status">
      <div>已搜索到 23 个网页</div>
      <div class="search-item">[1] 排序算法 - Wikipedia</div>
      <div class="search-item">[2] quicksort - 菜鸟教程</div>
    </div>` : ''}
    <div class="ds-markdown">${bodyHtml}</div>
    <div class="actions">
      <button>复制</button><button>重新生成</button><button>点赞</button>
    </div>
  </div>`;
}

const conversation = `
<div id="root">
  <aside class="sidebar"><a href="/a/chat/s/x">侧边栏里的旧会话标题</a></aside>
  <main class="chat">
    <div class="turn user"><div class="fbb737a4"><p>帮我讲讲冒泡排序</p></div></div>
    ${answer('<p>冒泡排序的核心是相邻两两比较。</p><ul><li>稳定</li><li>O(n²)</li></ul>')}
    <div class="turn user"><div class="fbb737a4"><p>那快排呢？</p></div></div>
    ${answer('<p>快排选基准，分左右递归。</p>')}
    <div class="editor"><textarea placeholder="给 DeepSeek 发送消息"></textarea></div>
  </main>
</div>`;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('思考块写在 .ds-markdown 里面时，也要被剔掉', () => {
  // DeepSeek 新版把「已思考（用时 15 秒）」折叠块直接塞进回答块里
  const html = `<div id="root"><main>
    <div class="fbb737a4"><p>问题</p></div>
    <div class="ds-markdown">
      <div class="ds-think-block"><span>已思考（用时 15 秒）</span>
        <div class="think-content"><p>用户现在提出了一个非常具体的地理逻辑问题。</p></div>
      </div>
      <p>这是真正的回答正文。</p>
    </div>
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  const answerText = items.filter((i) => i.role === 'assistant').map((i) => i.content).join('\n');
  assert.ok(answerText.includes('这是真正的回答正文。'), answerText);
  assert.ok(!answerText.includes('用户现在提出了'), '思考过程混进来了：\n' + answerText);
  assert.ok(!answerText.includes('已思考'), '思考提示混进来了：\n' + answerText);
});

test('只保留正文：思考过程、搜索列表、按钮都不进来', () => {
  const { refine } = loadRefine(conversation);
  const items = refine.extractClean();
  const text = items.map((i) => i.content).join('\n');
  const roles = items.map((i) => i.role).join(',');

  assert.equal(roles, 'user,assistant,user,assistant', '角色顺序不对：' + roles);
  assert.ok(text.includes('帮我讲讲冒泡排序'));
  assert.ok(text.includes('冒泡排序的核心是相邻两两比较。'));
  assert.ok(text.includes('快排选基准，分左右递归。'));
  assert.ok(!text.includes('已深度思考'), '思考过程标题漏水了：\n' + text);
  assert.ok(!text.includes('用户问的是排序'), '思考内容漏水了');
  assert.ok(!text.includes('已搜索到'), '搜索列表漏水了');
  assert.ok(!text.includes('菜鸟教程'), '搜索结果漏水了');
  assert.ok(!text.includes('复制'), '按钮文字漏水了');
  assert.ok(!text.includes('重新生成'), '按钮文字漏水了');
  assert.ok(!text.includes('侧边栏里的旧会话标题'), '侧边栏漏水了');
  assert.ok(!text.includes('给 DeepSeek 发送消息'), '输入框漏水了');
});

test('正文里的列表格式还在（含 <p>/<li> 时保留换行）', () => {
  const { refine } = loadRefine(conversation);
  const items = refine.extractClean();
  const answer1 = items[1].content;
  assert.ok(answer1.includes('稳定'), answer1);
  assert.ok(answer1.includes('O(n²)'), answer1);
  assert.ok(answer1.includes('\n'), '列表项之间应该有换行：' + JSON.stringify(answer1));
});

test('没有思考和搜索块时，正文一个字都不丢', () => {
  const html = `<div id="root"><main>
    ${answer('<p>第一段。</p><p>第二段。</p>', { think: false, search: false })}
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  assert.equal(items.length, 1);
  assert.equal(items[0].content, '第一段。\n\n第二段。');
});

test('同一条回答里既有正文又混进了按钮：退回到正文块本身，不冒险', () => {
  const html = `<div id="root"><main>
    <div class="turn">
      <div class="ds-markdown"><p>正文一句话。</p></div>
      <button>复制</button>
    </div>
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  assert.equal(items.length, 1);
  assert.equal(items[0].content, '正文一句话。');
});

test('代码块不会被当成「无关内容」丢掉', () => {
  const html = `<div id="root"><main>
    ${answer('<p>看这段：</p><pre><code>let a = 1;\nlet b = 2;</code></pre>')}
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  assert.equal(items.length, 1);
  assert.ok(items[0].content.includes('let a = 1;'), items[0].content);
  assert.ok(items[0].content.includes('let b = 2;'), items[0].content);
  assert.ok(!items[0].content.includes('已深度思考'));
});

test('思考块被「已思考（用时N秒）」外壳包着时：丢掉思考块，保留真正的回答', () => {
  // DeepSeek 现在的真实结构：思考正文本身也是 .ds-markdown，外面套一层带标记的容器
  const html = `<div id="root"><main>
    <div class="turn user"><div class="fbb737a4"><p>提问 0</p></div></div>
    <div class="turn">
      <div class="think-wrap"><div class="think-head">已思考（用时 15 秒）</div>
        <div class="ds-markdown"><p>好的，用户这次的问题是基于我上次的回答，需要先分析一下。</p></div>
      </div>
      <div class="ds-markdown"><p>这是第 0 轮真正的回答。</p></div>
    </div>
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  const text = items.map((i) => String(i.content)).join('\n');

  assert.ok(text.includes('这是第 0 轮真正的回答。'), '回答被误杀了：\n' + text);
  assert.ok(!text.includes('需要先分析一下'), '思考过程漏出来了：\n' + text);
  assert.equal(items.filter((i) => i.role === 'assistant').length, 1, '回答块数量应是 1：' + JSON.stringify(items));
});

test('嵌套的 .ds-markdown 不会重复导出', () => {
  const html = `<div id="root"><main>
    <div class="ds-markdown"><p>外层</p><div class="ds-markdown"><p>内层</p></div></div>
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  assert.equal(items.length, 1, '嵌套块被导出了 ' + items.length + ' 次');
  assert.ok(items[0].content.includes('外层'));
});

test('多轮对话不会互相串行', () => {
  const html = `<div id="root"><main>
    <div class="turn user"><div class="fbb737a4"><p>帮我讲讲冒泡排序</p></div></div>
    <div class="turn"><div class="ds-markdown"><p>冒泡排序的核心是相邻两两比较。</p></div></div>
    <div class="turn user"><div class="fbb737a4"><p>那快排呢？</p></div></div>
    <div class="turn"><div class="ds-markdown"><p>快排选基准，分左右递归。</p></div></div>
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  assert.equal(items.map((i) => i.role).join(','), 'user,assistant,user,assistant', JSON.stringify(items));
  const contents = items.map((i) => String(i.content));
  assert.equal(contents.length, 4);
  assert.equal(contents[0], '帮我讲讲冒泡排序');
  assert.equal(contents[1], '冒泡排序的核心是相邻两两比较。');
  assert.equal(contents[2], '那快排呢？');
  assert.equal(contents[3], '快排选基准，分左右递归。');
});

test('用户气泡里内嵌 ds-markdown 时，只算一条用户消息', () => {
  const html = `<div id="root"><main>
    <div class="fbb737a4"><div class="ds-markdown"><p>我的问题</p></div></div>
    <div class="ds-markdown"><p>回答内容</p></div>
  </main></div>`;
  const { refine } = loadRefine(html);
  const items = refine.extractClean();
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.equal(items[0].role, 'user');
  assert.equal(items[0].content, '我的问题');
  assert.equal(items[1].role, 'assistant');
  assert.equal(items[1].content, '回答内容');
});

/* ---------------------------------------------- 页面改版：类名全变了 */

test('类名变了（没有 .ds-markdown / .fbb737a4）时，通用扫描仍能拿到正文', () => {
  const html = `<div id="root"><aside><a href="/a/chat/s/x">旧会话</a></aside><main class="chat">
    <div class="msg-user"><p>我的提问</p></div>
    <div class="msg-bot"><div class="markdown-body"><p>回答的第一段。</p><p>回答的第二段。</p></div></div>
  </main></div>`;
  const { refine } = loadRefine(html);

  // 标准提取应当拿不到（这正是之前导出只剩标题的原因）
  assert.equal(refine.extractClean().length, 0, '这个页面本来就没有标准类名');

  const items = refine.extractGeneric();
  const text = items.map((i) => i.content).join('\n');
  assert.ok(text.includes('我的提问'), text);
  assert.ok(text.includes('回答的第一段。'), text);
  assert.ok(text.includes('回答的第二段。'), text);
  assert.ok(!text.includes('旧会话'), '侧边栏不应该被抓进来：' + text);
  // 不能重复输出
  assert.equal((text.match(/回答的第一段。/g) || []).length, 1, '内容重复了：' + text);
});

test('exporter 在标准选择器全空时自动改用通用扫描', async () => {
  const html = `<div id="root"><main>
    <div class="whatever"><p>换个类名的提问</p></div>
    <div class="whatever2"><p>换个类名的回答</p></div>
  </main></div>`;
  const dom = new JSDOM(html, { url: 'https://chat.deepseek.com/a/chat/s/sess-0001-abcd', pretendToBeVisual: true });
  const window = dom.window;
  window.document.title = '测试会话 - DeepSeek';
  window.localStorage.setItem('user_token', JSON.stringify({ value: 'fake-token-value-123456' }));
  window.fetch = async () => { throw new Error('offline'); };
  vm.createContext(window);
  for (const f of ['refine.js', 'format.js', 'exporter.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), window, { filename: f });
  }
  const r = await window.DSExportCore.runExport({
    scope: 'current', records: [], exports: 'chat', mode: 'chat', onLog: () => {}
  });
  assert.ok(r.text.includes('换个类名的提问'), r.text);
  assert.ok(r.text.includes('换个类名的回答'), r.text);
});

test('保底直取：标准/宽松/通用全都空时，仍能从 .ds-markdown 拿到正文', async () => {
  // 只保留 .ds-markdown 文字，故意破坏其它所有识别特征
  const html = '<div id="root">' +
    '<div class="ds-markdown">第一段正文内容</div>' +
    '<div class="ds-markdown">第二段正文内容</div>' +
    '</div>';
  const dom = new JSDOM(html, { url: 'https://chat.deepseek.com/a/chat/s/sess-1', pretendToBeVisual: true });
  const window = dom.window;
  window.localStorage.setItem('user_token', JSON.stringify({ value: 'fake-token-value-123456' }));
  window.fetch = async () => { throw new Error('offline'); };
  vm.createContext(window);
  for (const f of ['refine.js', 'format.js', 'exporter.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), window, { filename: f });
  }

  const dump = window.DSExportCore._internals.extractRawDump();
  assert.equal(dump.length, 2, JSON.stringify(dump));
  assert.equal(String(dump[0].content), '第一段正文内容');

  const items = window.DSExportCore._internals.extractDom();
  assert.ok(items.length >= 2, 'extractDom 应该至少拿到 2 条：' + JSON.stringify(items));
  const text = items.map((i) => String(i.content)).join('\n');
  assert.ok(text.includes('第一段正文内容'), text);
});

test('虚拟滚动：任意时刻只渲染 3 轮，也能靠边滚边收集拿全 12 轮', async () => {
  const ALL = [];
  for (let i = 0; i < 12; i++) {
    ALL.push(`<div class="turn user"><div class="fbb737a4"><p>提问 ${i}</p></div></div>`);
    ALL.push(`<div class="turn"><div class="ds-markdown"><p>回答 ${i} 的内容。</p></div></div>`);
  }

  const dom = new JSDOM('<div id="root"><div id="scroller"></div></div>', {
    url: 'https://chat.deepseek.com/a/chat/s/4b75', pretendToBeVisual: true
  });
  const window = dom.window;
  const scroller = window.document.getElementById('scroller');
  const ROW = 400;
  let viewStart = 9;
  let top = 12 * ROW - 600;

  Object.defineProperty(scroller, 'clientHeight', { get: () => 600, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 12 * ROW, configurable: true });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v) => {
      top = Math.max(0, Math.min(v, 12 * ROW - 600));
      viewStart = Math.max(0, Math.min(Math.floor(top / ROW) - 1, 12 - 3));
      render();
    },
    configurable: true
  });

  function render() {
    const out = [];
    for (let r = viewStart; r < Math.min(viewStart + 3, 12); r++) out.push(ALL[r * 2], ALL[r * 2 + 1]);
    scroller.innerHTML = out.join('');
  }
  render();

  window.document.title = '君主制 - DeepSeek';
  window.localStorage.setItem('user_token', JSON.stringify({ value: 'fake-token-value-123456' }));
  window.fetch = async () => { throw new Error('offline'); };
  vm.createContext(window);
  for (const f of ['refine.js', 'format.js', 'exporter.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), window, { filename: f });
  }

  const r = await window.DSExportCore.runExport({
    scope: 'current', records: [], exports: 'chat', mode: 'chat', autoScroll: true, onLog: () => {}
  });

  const asked = (r.text.match(/提问 \d+/g) || []).length;
  assert.equal(asked, 12, '应该拿到 12 轮，实际 ' + asked + '：\n' + r.text);
  // 顺序必须是从旧到新
  assert.ok(r.text.indexOf('提问 0') < r.text.indexOf('提问 11'));
  assert.ok(r.text.includes('回答 11 的内容。'), '最新的回答不能丢（滚到顶时它会被卸载）：\n' + r.text);
});

test('主路径是 1.1.0 那套，且能补回「找不到提问」的情况', async () => {
  const dom = new JSDOM(conversation, { url: 'https://chat.deepseek.com/a/chat/s/sess-0001-abcd', pretendToBeVisual: true });
  const window = dom.window;
  window.localStorage.setItem('user_token', JSON.stringify({ value: 'fake-token-value-123456' }));
  window.fetch = async () => { throw new Error('offline'); };

  // 先装 refine，再按 content-script 的顺序装 exporter
  vm.createContext(window);
  vm.runInContext(source, window, { filename: 'refine.js' });
  const exporterSource = fs.readFileSync(new URL('../src/exporter.js', import.meta.url), 'utf8');
  vm.runInContext(exporterSource, window, { filename: 'exporter.js' });

  const items = window.DSExportCore._internals.extractDom();
  const text = items.map((i) => String(i.content)).join('\n');

  // 内容必须在
  assert.ok(text.includes('冒泡排序的核心是相邻两两比较。'), text);
  assert.ok(text.includes('快排选基准，分左右递归。'), text);
  // 搜索列表不能污染正文 / 不能冒充用户提问
  assert.ok(!text.includes('已搜索到'), '搜索列表混进来了：\n' + text);
  // 策略应该是主路径（1.1.0 那套）
  const diag = window.DSExportCore._internals.lastDomDiagnostics();
  assert.equal(diag.strategy, 'loose', JSON.stringify(diag));
  // 角色必须对：问答都要有，不能全是 assistant
  const roles = items.map((i) => i.role);
  assert.ok(roles.includes('user'), '一条用户提问都没识别出来：' + JSON.stringify(roles));
  assert.ok(roles.includes('assistant'), '一条回答都没识别出来：' + JSON.stringify(roles));
});

test('提问气泡和回答块不在同一父容器时，也补得出提问（否则会 0 轮提问）', async () => {
  const html = `<div id="root">
    <div class="bubble-wrap"><div class="fbb737a4"><p>提问 A</p></div></div>
    <div class="answer-wrap"><div class="ds-markdown"><p>回答 0</p></div></div>
    <div class="answer-wrap"><div class="ds-markdown"><p>回答 1</p></div></div>
    <div class="bubble-wrap"><div class="fbb737a4"><p>提问 B</p></div></div>
    <div class="answer-wrap"><div class="ds-markdown"><p>回答 2</p></div></div>
  </div>`;
  const dom = new JSDOM(html, { url: 'https://chat.deepseek.com/a/chat/s/sess-1', pretendToBeVisual: true });
  const window = dom.window;
  window.localStorage.setItem('user_token', JSON.stringify({ value: 'fake-token-value-123456' }));
  window.fetch = async () => { throw new Error('offline'); };
  vm.createContext(window);
  for (const f of ['refine.js', 'format.js', 'exporter.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), window, { filename: f });
  }

  const items = window.DSExportCore._internals.extractDom();
  const users = items.filter((i) => i.role === 'user').map((i) => String(i.content));
  const answers = items.filter((i) => i.role === 'assistant').map((i) => String(i.content));

  assert.equal(answers.length, 3, '回答数不对：' + JSON.stringify(answers));
  assert.ok(users.includes('提问 A'), '第一个提问没补出来：' + JSON.stringify(users));
  assert.ok(users.includes('提问 B'), '第二个提问没补出来：' + JSON.stringify(users));
});

test('refine 的干净提取仍然可用（作为第二层）', async () => {
  const dom = new JSDOM(conversation, { url: 'https://chat.deepseek.com/a/chat/s/sess-0001-abcd', pretendToBeVisual: true });
  const window = dom.window;
  vm.createContext(window);
  vm.runInContext(source, window, { filename: 'refine.js' });
  const clean = window.DSExportRefine.extractClean();
  const text = clean.map((i) => String(i.content)).join('\n');
  assert.ok(text.includes('冒泡排序的核心是相邻两两比较。'), text);
  assert.ok(!text.includes('已深度思考'));
  assert.ok(!text.includes('已搜索到'));
  assert.ok(!text.includes('重新生成'));
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
