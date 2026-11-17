/* DeepSeek 对话导出 —— 排版（隔离世界）
 *
 * 把导出的 messages 排成「能直接粘进 AI、能直接读」的文本，省 token 也省眼睛：
 *
 *   chat     发言人1：内容            —— 微信 / QQ 聊天记录风格（默认，最省 token）
 *   markdown 标题 + 人设前缀 + 分隔线 —— 想保留 Markdown 排版时用
 *   text     纯文本，去掉 Markdown 记号
 *
 * 顺手做的清洗（这几种东西导出后基本没人要，却最占体积）：
 *   - 助手回复里的「已深度思考（用时 12 秒）」+ 折叠块
 *   - 「已搜索到 N 个网页」「已阅读 N 个网页」列表
 *   - 「N 个网页」「[citation:3]」这类引用标记
 *   - 流式状态文字、单独的引用链接列表（若正文已带链接则整行丢掉）
 *
 * 不做的事：不改写正文语义，不删任何一句话 —— 只用正则去掉结构性的噪声。
 */
(function () {
  'use strict';

  if (window.DSExportFormat) return;

  var FORMATS = ['chat', 'markdown', 'text'];
  var SEPARATOR = '\n\n';

  /* ---------------------------------------------------------------- 小工具 */

  function str(v) {
    return v == null ? '' : String(v);
  }

  /* ------------------------------------------------- 代码块 / 行内代码保护 */

  var FENCE = '```';

  /* 占位符只用可见字符：字符串里的 \u0000 会被当成真的 NUL，传给 new RegExp 会直接抛错。
   * 前后加不可见的私有区字符，防止正文里恰好出现同样的字样被误替换。 */
  var PLACEHOLDER_HEAD = '\ue000DSCODE';
  var PLACEHOLDER_TAIL = '\ue001';
  var PLACEHOLDER_RE = /\ue000DSCODE(\d+)\ue001/g;

  /**
   * 把内容拆成「普通段落」与「代码块」，普通段落才做 Markdown 收敛与清洗。
   * 返回 { text, codes }，codes[i] 是第 i 个代码块（不带围栏）。
   */
  function protectFences(content) {
    var codes = [];
    if (content.indexOf(FENCE) === -1) return { text: content, codes: codes };

    var lines = content.replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var buf = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = /^\s*(```+|~~~+)/.exec(line);
      if (buf) {
        if (m) {
          codes.push(buf.join('\n'));
          out.push(PLACEHOLDER_HEAD + (codes.length - 1) + PLACEHOLDER_TAIL);
          buf = null;
        } else {
          buf.push(line);
        }
        continue;
      }
      if (m) {
        buf = [];
        continue;           // 开头的 ```lang 行不进内容
      }
      out.push(line);
    }
    if (buf) {
      // 没闭合的代码块：当作普通文本，否则内容会被吞掉
      out.push(buf.join('\n'));
    }
    return { text: out.join('\n'), codes: codes };
  }

  function restoreCodes(text, codes, mode) {
    PLACEHOLDER_RE.lastIndex = 0;
    return text.replace(PLACEHOLDER_RE, function (m, idx) {
      var code = codes[Number(idx)];
      if (code === undefined) return '';
      if (mode === 'chat') return code;
      return FENCE + '\n' + code + '\n' + FENCE;
    });
  }

  /**
   * 「标题 + 下划线」这种纯文本标题栏。
   * 标题没有价值但用户每次都要付这几个字，所以只留一行标题，不再配下划线装饰。
   */
  function titleBlock(title) {
    return title;
  }  /* ------------------------------------------------------------ 噪声清理 */

  /**
   * 回复开头的高亮块（引用、摘要）先收成普通段落：这样它也会参与清洗，
   * 混进去的「已阅读 N 个网页」之类才不会在正文中间冒出来。
   */
  function unquoteHead(text) {
    var blocks = text.split(/\n{2,}/);
    if (!blocks.length) return text;
    var head = blocks[0];
    var lines = head.split('\n');
    var quoted = 0;
    lines.forEach(function (l) { if (QUOTE_LINE.test(l)) quoted++; });
    if (!quoted) return text;
    var rest = lines.filter(function (l) { return !QUOTE_LINE.test(l); });
    if (rest.some(function (l) { return l.trim(); })) return text;   // 混了正文，别动
    blocks[0] = lines.map(function (l) { return l.replace(/^[ \t]*[>|｜][ \t]?/, ''); }).join('\n');
    return blocks.join('\n\n');
  }
  var SEARCH_HEAD = /(已搜索到\s*\d+\s*个网页|已阅读\s*\d+\s*个网页|搜索到\s*\d+\s*个网页)/;
  var QUOTE_LINE = /^[ \t]*[>|｜][ \t]*\S/;
  // 思考提示行：注意要覆盖「已思考（用时 11 秒）」这种新文案，不能只认「已深度思考」
  var THINK_SUMMARY = /^[ \t]*(已深度思考|深度思考中|思考过程|已思考|正在思考|已停止思考)(?:[ \t]*[（(]用时[ \d.]+秒[）)])?[ \t]*$/gm;
  var BULLET_LINE = /^[ \t]*[>|｜]?[ \t]*(\d{1,2}\.[ \t]*\S|[-*+][ \t]+\S)/;

  var STATUS_LINE = /^[ \t]*(已停止生成|继续生成|正在生成中?|生成中|已终止生成|内容加载失败)[ \t]*$/gm;
  var CITATION = /[ \t]*(\[?citation:\d+\]?|【citation:\d+】)/gi;
  var WEB_REFS = /[ \t]*(\[\d{1,2}\]|【\d{1,2}】)/g;
  var LINK = /\[([^\]\n]{1,60})\]\((https?:\/\/[^)\s]+)\)/g;

  /**
   * 「已搜索到 N 个网页」+ 紧随其后的引用列表整块去掉。
   * 用状态机而不是正则：列表可能有好几行，正则的 lastIndex 续接行为很容易漏掉中间几行。
   */
  function dropSearchBlocks(lines) {
    var out = [];
    var skipping = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (SEARCH_HEAD.test(line) && (QUOTE_LINE.test(line) || /^[ \t]*\S.{0,80}$/.test(line))) {
        skipping = true;          // 标题行本身也丢
        continue;
      }
      if (skipping) {
        if (!line.trim()) continue;
        if (QUOTE_LINE.test(line) || BULLET_LINE.test(line)) continue;
        skipping = false;         // 碰到普通正文，结束这一段
      }
      out.push(line);
    }
    return out;
  }

  function cleanPlain(text) {
    var lines = text
      .replace(THINK_SUMMARY, '')
      .split('\n');
    lines = dropSearchBlocks(lines);
    return lines.join('\n')
      .replace(STATUS_LINE, '')
      .replace(CITATION, '')
      .replace(WEB_REFS, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  /** 单独的「引用来源」链接列表：只在它是短占位块、且正文已有链接时才整行丢 */
  function dropTrailingLinkList(text) {
    var lines = text.split('\n');
    var tailStart = lines.length;
    var sawLink = false;

    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (!line) {
        // 末尾空行直接跳过；但已经收过链接之后，空行就是正文分隔，停下
        if (sawLink) break;
        tailStart = i;
        continue;
      }
      var matches = line.match(LINK) || [];
      var stripped = line.replace(LINK, '').replace(/[\s,.;:，。；：、\-|>&]/g, '');
      if (matches.length && stripped.length <= 12) {
        tailStart = i;
        sawLink = true;
      } else {
        break;
      }
    }
    if (!sawLink || tailStart === lines.length) return text;

    var head = lines.slice(0, tailStart);
    var bodyLinks = 0;
    head.forEach(function (l) { bodyLinks += (l.match(LINK) || []).length; });
    if (bodyLinks === 0) return text;     // 正文没链接，这就是唯一来源，留着
    return head.join('\n').replace(/\s+$/, '');
  }

  /* ------------------------------------------------------- 单条消息清洗 */

  /**
   * @param {Object} message  exporter 产出的 message
   * @param {'chat'|'markdown'|'text'} mode
   * @returns {string} 可直接拼进文档的正文
   */
  function cleanContent(message, mode) {
    var raw = str(message && message.content);
    if (!raw) return '';
    if (message && message.role === 'user') return raw.trim();

    var fenced = protectFences(raw);
    var body = fenced.text;

    if (mode === 'text') {
      body = body
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^[ \t]*[-*+][ \t]+/gm, '- ')
        .replace(/^[ \t]*(\d+)\.(?!\d)[ \t]+/gm, '$1. ')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
        .replace(/[\u00a0\u200b\ufeff]/g, '');
    }

    body = body
      .replace(/[\u00a0\u200b\ufeff]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n');

    body = cleanPlain(body);
    if (mode === 'chat') {
      body = unquoteHead(body);
      body = dropTrailingLinkList(body);
    }
    body = body.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');

    return restoreCodes(body, fenced.codes, mode);
  }

  /* ---------------------------------------------------------- 发言人编号 */

  /** 同一个人连续说话合并成一个发言人（多轮 tool_call / 中断重答时很常见） */
  function assignSpeakers(messages) {
    var labels = { user: '我', assistant: 'DeepSeek' };
    var byKey = {};
    var next = 1;
    var prev = null;
    var round = 0;
    var out = [];

    messages.forEach(function (m) {
      var role = m && m.role ? m.role : 'unknown';
      if (role === 'system') return;
      var key = role === 'user' || role === 'assistant' ? role : 'unknown';
      if (key === 'unknown' && prev && prev.key === 'unknown' && !(m && m.content)) return;

      if (!byKey[key]) {
        byKey[key] = { index: next++, label: labels[key] || '系统' };
      }
      prev = byKey[key];
      if (key === 'user' || round === 0) round++;
      out.push({ message: m, key: key, speaker: byKey[key], round: round });
    });

    return out;
  }

  function speakerLabel(sp) {
    return '发言人' + sp.index + '（' + sp.label + '）';
  }

  /* -------------------------------------------------------------- 排版 */

  function timeLabel(message) {
    var raw = message && message.inserted_at_iso;
    if (!raw) return '';
    var date = new Date(raw);
    if (isNaN(date.getTime())) return '';
    return ' [' + date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') + ']';
  }

  function formatChat(turns, mode) {
    var blocks = [];
    turns.forEach(function (t) {
      var body = cleanContent(t.message, 'chat');
      if (!body) return;
      blocks.push('第' + t.round + '轮 · ' + speakerLabel(t.speaker) + timeLabel(t.message) + '：' + body);
    });
    return blocks.join(SEPARATOR);
  }

  function formatMarkdown(turns, mode) {
    var blocks = [];
    turns.forEach(function (t) {
      var body = cleanContent(t.message, 'markdown');
      if (!body) return;
      var prefix = t.key === 'user' ? '**我**' : t.key === 'assistant' ? '**DeepSeek**' : '**系统**';
      blocks.push('第' + t.round + '轮 · ' + prefix + '：\n\n' + body);
    });
    return blocks.join(SEPARATOR + '---' + SEPARATOR);
  }

  function formatPlain(turns) {
    var blocks = [];
    turns.forEach(function (t) {
      var body = cleanContent(t.message, 'text');
      if (!body) return;
      blocks.push('第' + t.round + '轮 · ' + speakerLabel(t.speaker) + timeLabel(t.message) + '：' + body);
    });
    return blocks.join(SEPARATOR);
  }

  /**
   * @param {{title?:string, messages:Array}} session
   * @param {{mode?:'chat'|'markdown'|'text', header?:boolean, maxChars?:number}} opts
   * @returns {{format:string, text:string, chars:number, total_chars:number, truncated:boolean, speakers:Object}}
   */
  function formatSession(session, opts) {
    opts = opts || {};
    var mode = FORMATS.indexOf(opts.mode) === -1 ? 'chat' : opts.mode;
    var messages = (session && session.messages) || [];
    var turns = assignSpeakers(messages);

    var body = mode === 'markdown' ? formatMarkdown(turns) : mode === 'text' ? formatPlain(turns) : formatChat(turns);
    var total = body.length;
    var truncated = false;
    var maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0;

    if (maxChars && body.length > maxChars) {
      body = body.slice(0, maxChars);
      // 只截到完整段落为止：宁可短一点，也不要留半句或半个「发言人2（…）」标签
      var lastBreak = body.lastIndexOf('\n\n');
      if (lastBreak > 0) body = body.slice(0, lastBreak);
      body = body.replace(/\s+$/, '');
      truncated = true;
    }

    var speakers = {};
    turns.forEach(function (t) {
      if (speakers[t.key] === undefined) speakers[t.key] = t.speaker.label;
    });

    var text = body;
    if (opts.header !== false) {
      var title = str(session && session.title) || '未命名对话';
      text = mode === 'markdown'
        ? '# ' + title + '\n\n' + body
        : title + '\n\n' + body;
    }
    if (truncated) {
      text += (mode === 'markdown' ? SEPARATOR : '\n\n') +
        '（已截断：原文共 ' + total + ' 字符，此处保留前 ' + maxChars + ' 字符）';
    }

    return {
      format: mode,
      text: text.replace(/\s+$/, ''),
      chars: text.length,
      total_chars: total,
      truncated: truncated,
      speakers: speakers
    };
  }

  /** 多个会话拼成一份（全部会话导出 / 批量复制时用） */
  function formatSessions(sessions, opts) {
    opts = opts || {};
    var parts = [];
    var truncated = false;
    var total = 0;
    (sessions || []).forEach(function (s) {
      var one = formatSession(s, opts);
      total += one.total_chars;
      if (one.truncated) truncated = true;
      if (!one.text) return;
      parts.push(one.text);
    });
    var sep = opts.mode === 'markdown' ? '\n\n---\n\n' : '\n\n════════\n\n';
    var text = parts.join(sep);
    var maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0;
    if (maxChars && text.length > maxChars) {
      text = text.slice(0, maxChars).replace(/\s+$/, '');
      truncated = true;
    }
    return { format: opts.mode === 'markdown' ? 'markdown' : opts.mode === 'text' ? 'text' : 'chat', text: text, chars: text.length, total_chars: total, truncated: truncated };
  }

  window.DSExportFormat = {
    FORMATS: FORMATS,
    formatSession: formatSession,
    formatSessions: formatSessions,
    _internals: {
      cleanContent: cleanContent,
      protectFences: protectFences,
      restoreCodes: restoreCodes,
      cleanPlain: cleanPlain,
      dropTrailingLinkList: dropTrailingLinkList,
      assignSpeakers: assignSpeakers,
      speakerLabel: speakerLabel
    }
  };
})();
