/* DeepSeek 对话导出 —— 对话正文脱壳（隔离世界）
 *
 * DeepSeek 页面里一条「助手回答」并不是只有 .ds-markdown：它前面往往还挂着
 *   · 已深度思考（用时 12 秒） + 可展开的思考块
 *   · 已搜索到 23 个网页 / 已阅读 14 个网页 的折叠列表
 *   · 复制 / 重新生成 / 点赞 这些按钮
 * 直接按「答案块的父容器」取 innerText 就会把上面这些一起扒进导出文件 ——
 * 词元就是这么被吃掉的。
 *
 * refine.js 只在 DOM 兜底时用：按文档顺序把「正文块」严格排出来，每个正文块取
 * 尽量小且干净的祖先。父容器里只要多出正文以外的东西（不是纯正文标签、不是纯空白），
 * 就退回正文块本身 —— 宁可少要格式，也绝不把无关内容带出去。
 */
(function () {
  'use strict';

  if (window.DSExportRefine) return;

  var OPTIONS_RE = /^[ \t]*(重新生成|再生成|继续生成|停止生成|复制|复制代码|运行代码|分享|编辑|删除|点赞|不喜欢|喜欢)[ \t]*$/;
  var REFS_RE = /^(参考来源|引用来源|来源|参考资料|参考链接|References?)[ \t]*[:：]?$/i;
  var N = 1000; // compactText 段分隔符

  function isElement(node) {
    return !!(node && node.nodeType === 1);
  }

  /** 嵌套的答案块只留最外层（DeepSeek 偶尔会套两层 .ds-markdown） */
  function outermost(elements) {
    return elements.filter(function (el) {
      return !elements.some(function (other) { return other !== el && other.contains(el); });
    });
  }

  /** 折叠 / line-clamp 会让 innerText 截断，取文本前临时解除 */
  function unclamp(elements) {
    var touched = [];
    elements.forEach(function (root) {
      var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
      nodes.forEach(function (n) {
        if (!n.style) return;
        var s = window.getComputedStyle(n);
        if (!s) return;
        var clamp = s.webkitLineClamp || s.lineClamp;
        var hidden = s.overflow === 'hidden' || s.overflowY === 'hidden';
        var capped = s.maxHeight && s.maxHeight !== 'none';
        if ((clamp && clamp !== 'none') || (hidden && capped)) {
          touched.push({ node: n, style: n.getAttribute('style') });
          try {
            n.style.webkitLineClamp = 'unset';
            n.style.lineClamp = 'unset';
            n.style.maxHeight = 'none';
            n.style.overflow = 'visible';
          } catch (e) { /* ignore */ }
        }
      });
    });
    return touched;
  }

  var BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,tr,blockquote,pre,div.ds-markdown';
  var BLOCK_INLINE_SEL = 'strong,em,b,i,u,s,del,code';
  var LINE_BREAK = '\ue002';   // 块与块之间的临时分隔符，最后换成换行
  var INLINE_BREAK = '\ue003'; // 行内元素边界（不加空格、也不加换行）
  var INNER_BREAK = INLINE_BREAK;

  /** 跨 world 取字符串：必须显式转成字符串，不能直接拼 DOM 里拿到的 String 对象 */
  function textOf(node) {
    return '' + (node && (node.nodeValue != null ? node.nodeValue : node.textContent) || '');
  }

  function inlineText(node) {
    /* eslint-disable-next-line no-constant-condition */
    if (node.nodeType === 3) return textOf(node);
    var out = '';
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === 3) { out += textOf(child); continue; }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName;
      if (tag === 'BR') { out += '\n'; continue; }
      var isBlock = child.matches && child.matches(BLOCK_SEL);
      var inner = inlineText(child);
      if (isBlock) {
        out += inner;                       // 块级子孙的换行交给下面统一处理
      } else if (child.matches && child.matches(BLOCK_INLINE_SEL)) {
        out += INNER_BREAK + inner + INNER_BREAK;
      } else {
        out += inner;
      }
    }
    return out;
  }

  /**
   * 用自己的遍历拼换行，不依赖 innerText —— content script 跑在 ISOLATED world，
   * 虽然共用 DOM，但 innerText 依赖布局与 documentElement 关系，跨 world 调不一定可靠。
   * 这里按块级元素切段，结果对两种 world 都一样。
   */
  function blockText(el) {
    var parts = [];

    function walk(node, out) {
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (child.nodeType === 3) { out.push(textOf(child)); continue; }
        if (child.nodeType !== 1) continue;
        if (child.tagName === 'BR') { out.push('\n'); continue; }
        if (child.matches && child.matches(BLOCK_SEL)) {
          out.push(LINE_BREAK);
          walk(child, out);
          out.push(LINE_BREAK);
        } else if (child.matches && child.matches(BLOCK_INLINE_SEL)) {
          out.push(INLINE_BREAK);
          walk(child, out);
          out.push(INLINE_BREAK);
        } else {
          walk(child, out);
        }
      }
      return out;
    }

    walk(el, parts);
    return parts.join('')
      .split(LINE_BREAK).join('\n')
      .split(INLINE_BREAK).join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  /**
   * 跨 world 取「可见文本」的兜底：innerText 不可用时用 textContent。
   * 只给老的宽松兜底逻辑用。
   */
  function safeText(el) {
    try {
      if (typeof el.innerText === 'string' && el.innerText) return el.innerText.trim();
    } catch (e) { /* ignore */ }
    var text = textOf(el);
    return replacementsText(text).trim();
  }

  function replacementsText(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .split(LINE_BREAK).join('\n')
      .split(INLINE_BREAK).join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  function restoreStyle(touched) {
    touched.forEach(function (t) {
      if (t.style === null) t.node.removeAttribute('style');
      else t.node.setAttribute('style', t.style);
    });
  }

  /** 思考块 / 搜索块 / 图标的类名特征：这些在正文里也要剔掉 */
  var NOISE_CLASS_RE = /(ds-think|think[-_]?(block|content|container|wrap|section)|reasoning|search-(result|list|status)|ds-search|ds-icon|avatar|toolbar|action-bar|ds-markdown-icon)/i;

  var THINK_MARKER_RE = /(已思考|深度思考|思考中|用时\s*\d+\s*秒)/;

  /**
   * 判断「这段正文其实是思考过程」。DeepSeek 的真实结构大致是：
   *
   *   <div class="turn">
   *     <div>                       ← 思考块外壳
   *       <div>已思考（用时 15 秒）</div>   ← 只写着标记的小元素
   *       <div class="ds-markdown">思考正文</div>
   *     </div>
   *     <div class="ds-markdown">真正的回答</div>
   *   </div>
   *
   * 思考正文本身也带 .ds-markdown，只能靠结构来认。判据：
   * 「在某个祖先里，紧挨在我前面、且文字只有『已思考（用时N秒）』这类标记」。
   * 这样既不会误伤同一轮里真正的回答（它前面的兄弟是整个思考块外壳，文字很长），
   * 也不依赖会变的类名。
   */
  function looksLikeThinking(el, root) {
    // 类名先兜一层
    var probe = el.parentElement;
    var g = 0;
    while (probe && probe !== root && probe.nodeType === 1 && g++ < 6) {
      if (isNoiseEl(probe)) return true;
      probe = probe.parentElement;
    }

    var node = el;
    var guard = 0;
    while (node && node !== root && node.nodeType === 1 && guard++ < 8) {
      var sib = node.previousElementSibling;
      while (sib) {
        var text = String(sib.textContent || '').trim();
        // 只认「短，且内容就是标记」的兄弟元素
        if (text && text.length <= 30 && THINK_MARKER_RE.test(text)) return true;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return false;
  }

  /** 元素本身是不是「思考 / 搜索 / 图标」这类噪声 */
  function isNoiseEl(el) {
    if (!el || el.nodeType !== 1) return false;
    var cls = typeof el.className === 'string' ? el.className : '';
    if (cls && NOISE_CLASS_RE.test(cls)) return true;
    var testid = el.getAttribute && (el.getAttribute('data-testid') || '');
    if (testid && /think|reasoning|search/i.test(testid)) return true;
    return false;
  }

  /**
   * 正文块内部的噪声：思考块经常被塞进 .ds-markdown 里，
   * 这类节点必须在取文本前物理删掉，否则会混进正文。
   */
  function stripThinking(root) {
    if (!root.querySelectorAll) return root;
    var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    nodes.forEach(function (n) {
      if (isNoiseEl(n) && n !== root && n.parentNode && root.contains(n)) n.parentNode.removeChild(n);
    });
    return root;
  }

  /** 页面上常有 <style>/<script>/<svg> 残留，innerText 不一定会算进去，这里显式去掉 */
  function stripJunk(root) {
    if (!root.querySelectorAll) return;
    Array.prototype.slice.call(root.querySelectorAll('style,script,noscript,template,svg,textarea,input'))
      .forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
  }

  /** 正文块本身自带的操作行（最后一行的「复制」「重新生成」之类） */
  function trimTrailingOptions(text) {
    var lines = text.replace(/\r/g, '').split('\n');
    while (lines.length && (!lines[lines.length - 1].trim() || OPTIONS_RE.test(lines[lines.length - 1]))) {
      lines.pop();
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ------------------------------------------------------------ 走 DOM 树 */

  /** 用 textContent（不做 innerText 的布局计算）+ 段分隔符压成一行，开销比 getComputedStyle 小得多 */
  function compactText(el) {
    return textOf(el).replace(/[\t ]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  /** 正文以外的东西一律带 F 标记：按钮、可编辑区、思考块、搜索块、隐藏块、代码块、行内代码 */
  function hasForeign(node, isLeaf) {
    if (!isElement(node)) return false;
    var tag = node.tagName;
    if (tag === 'BUTTON' || tag === 'SVG' || tag === 'INPUT' || tag === 'TEXTAREA' ||
      tag === 'PRE' || tag === 'CODE' || tag === 'STYLE' || tag === 'SCRIPT' ||
      (tag !== 'DIV' && /^(DS-|MDS-)/i.test(tag))) return true;

    var cls = typeof node.className === 'string' ? node.className : '';
    // 思考块 / 联网搜索块 / 图标 / 按钮：统一用 NOISE_CLASS_RE（和取文本时的清理规则保持一致）
    if (cls && NOISE_CLASS_RE.test(cls)) return true;
    if (node.getAttribute && /已思考|思考中|已深度思考|用时\s*\d+\s*秒/.test(node.getAttribute('data-testid') || '')) return true;
    if (node.getAttribute && /^(button|link|menuitem)$/.test(node.getAttribute('role') || '')) return true;

    var attr = node.getAttribute && node.getAttribute('contenteditable');
    if (attr === 'true' || attr === '') return true;

    if (isLeaf) return false;
    try {
      var s = window.getComputedStyle(node);
      if (s && (s.display === 'none' || s.visibility === 'hidden')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 保留的格式标签：块级用 B（会产出换行），行内用 I */
  var BLOCK_TAGS = { P: 1, LI: 1, UL: 1, OL: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, TABLE: 1, TR: 1, DIV: 1 };
  var INLINE_TAGS = {
    BR: 1, SPAN: 1, STRONG: 1, EM: 1, B: 1, I: 1, U: 1, S: 1, DEL: 1, A: 1, SUP: 1, SUB: 1,
    IMG: 1, TD: 1, TH: 1, THEAD: 1, TBODY: 1, FONT: 1, SMALL: 1, MARK: 1, INS: 1
  };

  var ALLOWED_TAGS = (function () {
    var t = {};
    Object.keys(BLOCK_TAGS).forEach(function (k) { t[k] = 'B'; });
    Object.keys(INLINE_TAGS).forEach(function (k) { t[k] = 'I'; });
    return t;
  })();

  /**
   * 严格签名：只认「正文标签 + 纯文本 + 空白文本节点」。
   * 任何别的东西（按钮/图标/思考块/代码块/隐藏块）都会把签名变成 F。
   * 返回 { sig, hasB }：
   *   sig   —— B/I/* 组成的形状串，"F" 表示含无关内容
   *   hasB  —— 是否含块级标签（没有说明是纯行内文本）
   */
  function strictSignature(el) {
    var sawForeign = false;
    var hasB = false;

    var walk = function (node) {
      if (sawForeign) return;
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (child.nodeType === 3) {
          if (textOf(child).trim()) return;  // 叶子文本
          continue;
        }
        if (child.nodeType !== 1) continue;
        var cls = ALLOWED_TAGS[child.tagName];
        if (!cls || hasForeign(child, false)) { sawForeign = true; return; }
        if (cls === 'B') hasB = true;
        walk(child);
        if (sawForeign) return;
      }
    };
    walk(el);

    if (sawForeign) return { sig: 'F', hasB: false };
    return { sig: hasB ? 'B' : 'I', hasB: hasB };
  }

  function isBlank(text) {
    return !String(text).replace(/[\s\u00a0\u200b\ufeff]+/g, '');
  }

  /**
   * 找出「一个正文块」的最小干净容器：
   * 从块本身往上走，并吃掉后面紧邻的正文兄弟节点，直到父容器里出现无关内容为止。
   * 返回值 total 为 null 时表示含无关内容（需要调用方按纯文本处理）。
   */
  /**
   * 判断某个容器是否「只含这一个正文块」：
   * 里面除了 block 自己这一支，不允许再出现任何正文块（别的 .ds-markdown / 用户气泡）。
   * 这条规则是防串行的关键 —— 一旦容器吃进了相邻的答案，整段对话就会被复制一遍。
   */
  function containsOnlyBlock(el, block, blockSelector) {
    if (!el.querySelectorAll) return true;
    var others = Array.prototype.slice.call(el.querySelectorAll(blockSelector));
    for (var i = 0; i < others.length; i++) {
      var other = others[i];
      if (other === block) continue;
      if (block.contains(other) || other.contains(block)) continue;
      return false;
    }
    return true;
  }

  function candidateFor(block, root, blockSelector) {
    var best = null;
    var node = block;

    for (var up = 0; up < 6; up++) {
      var parent = node.parentElement;
      if (!parent || !root.contains(parent)) break;
      // 父容器里一旦出现第二个正文块，就不能再往上吃了
      if (blockSelector && !containsOnlyBlock(parent, block, blockSelector)) break;

      var total = '';
      var foreign = false;
      var hasB = false;
      var sibs = Array.prototype.slice.call(parent.childNodes);

      for (var i = 0; i < sibs.length; i++) {
        var child = sibs[i];
        if (child.nodeType === 3) {
          if (!(child.nodeValue || '').trim()) continue;   // 纯空白：无所谓
          total += '*' + child.nodeValue.trim() + '*';      // 有实际文字：父容器就不够干净
          continue;
        }
        if (child.nodeType !== 1) continue;

        var tag = child.tagName;
        var allowed = tag === 'BR' || ALLOWED_TAGS[tag];
        if (!allowed || hasForeign(child, false)) { foreign = true; break; }

        var sig;
        if (child === node) {
          // 自己这一支：允许正文里夹代码 / 图标（块内嵌套的代码块是内容的一部分）
          sig = 'B';
          hasB = true;
        } else if (child.contains(block)) {
          foreign = true; break;
        } else {
          var res = strictSignature(child);
          if (res.sig === 'F') { foreign = true; break; }
          sig = res.sig;
          if (res.hasB) hasB = true;
        }
        total += (ALLOWED_TAGS[tag] === 'B' ? 'B' : 'I') + sig + (tag === 'BR' ? 'I' : '');
      }

      if (!foreign) {
        best = { el: parent, hasB: hasB, total: total || '' };
        node = parent;
      } else {
        break;
      }
    }

    if (best && best.hasB) return best;
    // 不到块级：用块本身，但块自己必须干净
    var self = strictSignature(block);
    if (self.sig === 'F') return null;
    return { el: block, hasB: self.hasB, total: self.sig };
  }

  /** 最近一次提取的统计（给体检 / 日志用） */
  var lastStats = { thinkingSkipped: 0, rounds: 0 };

  /**
   * 在 root 里按文档顺序收集正文块（用户气泡文本 + 每个 .ds-markdown），
   * 每个块用「最小干净容器」取文本 —— 思考过程、搜索列表、按钮都不在容器里。
   */
  function extractClean(rootOrDoc) {
    var root = rootOrDoc || document.body || document.documentElement;
    if (!root) return [];
    lastStats = { thinkingSkipped: 0, rounds: 0 };

    // 思考块里的正文也带 .ds-markdown，但它不是「回答」—— 靠祖先里的「已思考（用时N秒）」标记认出来并跳过
    var thinkingCount = 0;
    var mds = outermost(Array.prototype.slice.call(root.querySelectorAll('.ds-markdown'))).filter(function (md) {
      if (looksLikeThinking(md, root)) { thinkingCount++; return false; }
      return true;
    });
    if (thinkingCount) lastStats.thinkingSkipped = thinkingCount;

    var collected = [];
    mds.forEach(function (md) { collected.push({ el: md, role: 'assistant' }); });
    Array.prototype.slice.call(root.querySelectorAll('.fbb737a4')).forEach(function (el) {
      // 气泡里内嵌 .ds-markdown 是正常的（富文本输入），不能因此把气泡本身当成「答案的一部分」跳过。
      // 只有气泡整个被包在更外层的答案里时才跳过。
      var buriedInAnswer = mds.some(function (md) { return md !== el && md.contains(el); });
      if (!buriedInAnswer) collected.push({ el: el, role: 'user' });
    });

    // 用户气泡里常常内嵌 .ds-markdown（富文本输入 / 引用块），
    // 内层的那块是气泡的一部分，不能单独再算一条回答。
    // 只剔「严格在气泡内部」的，气泡自己不被剔除 —— 否则角色会丢。
    var userBubbles = collected.filter(function (b) { return b.role === 'user'; }).map(function (b) { return b.el; });
    var filtered = collected.filter(function (b) {
      if (b.role !== 'assistant') return true;
      return !userBubbles.some(function (u) { return u !== b.el && u.contains(b.el); });
    });

    // 需要去重时，角色从原来的块表里查；查不到就退回 assistant
    var blocks = outermostBlocks(filtered.map(function (b) { return b.el; })).map(function (el) {
      var role = 'assistant';
      for (var i = 0; i < filtered.length; i++) {
        if (filtered[i].el === el) { role = filtered[i].role; break; }
      }
      return { el: el, role: role };
    });

    if (!blocks.length) return [];
    blocks.sort(comparePosition);

    var BLOCK_SELECTOR = '.ds-markdown, .fbb737a4';

    // 候选容器只做一次 getComputedStyle，块本身（及其子节点）不碰
    var parsed = [];
    var seen = [];

    blocks.forEach(function (block) {
      if (seen.indexOf(block.el) !== -1) return;
      // 已经落在更外层正文块里的，跳过（避免同一段正文出现两次）
      if (seen.some(function (s) { return s !== block.el && s.contains(block.el); })) return;
      var cand = candidateFor(block.el, root, BLOCK_SELECTOR);
      seen.push(block.el);
      parsed.push({ el: cand ? cand.el : block.el, block: block.el, total: cand ? cand.total : null, role: block.role });
    });

    // 去重：容器被别的容器整个包住的丢掉
    parsed = parsed.filter(function (p, i) {
      return !parsed.some(function (other, j) { return j !== i && other.el !== p.el && other.el.contains(p.el); });
    });
    parsed.sort(function (a, b) { return comparePosition(a.el, b.el); });

    var out = [];
    parsed.forEach(function (p) {
      // 精确规则：父容器里除了正文什么都没有（纯正文标签 + 纯空白），才用父容器换格式；
      // 否则用正文块本身 —— 宁可少要格式，也不能把思考过程 / 搜索列表带出去。
      var clean = !p.total || /^(?:B|I(?:I|\*|BR)|\*)+$/.test(p.total);
      if (!clean) p.el = p.block;
      var text = textOfBlock(p.el);
      if (isBlank(text)) return;
      out.push({ role: p.role, content: text });
    });

    return out;
  }

  /** 取文本：解除折叠限制后用 blockText（不依赖跨 world 的 innerText） */
  function textOfBlock(el) {
    var clone = el.cloneNode(true);
    stripJunk(clone);
    stripThinking(clone);   // 思考块可能就嵌在回答块里，取文本前必须删掉
    var touched = [];
    try {
      touched = unclamp([clone]);
      return trimTrailingOptions(blockText(clone));
    } finally {
      restoreStyle(touched);
    }
  }

  /** 去掉互相嵌套的重复块，只留最外层 */
  function outermostBlocks(elements) {
    return elements.filter(function (el) {
      return !elements.some(function (other) { return other !== el && other.contains(el); });
    });
  }

  function insideAnswer(el, mds) {
    return mds.some(function (md) { return md.contains(el) || el.contains(md); });
  }

  /* ------------------------------------------------ 通用扫描（不看类名） */

  var SCAN_NOISE_CLASS = /(ds-think|think[-_]?(block|content|container)|reasoning|search-result|search-status|ds-search|svg|icon|avatar|button|btn|toolbar|action|sidebar|nav|menu|history)/i;
  var SCAN_SKIP_TAG = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|INPUT|BUTTON|SELECT|SVG|NAV|HEADER|FOOTER|ASIDE)$/;

  /** 侧边栏 / 顶栏 / 输入框区域：整棵跳过 */
  function inChrome(el, root) {
    var node = el;
    var guard = 0;
    while (node && node !== root && node.nodeType === 1 && guard++ < 30) {
      var tag = node.tagName;
      if (SCAN_SKIP_TAG.test(tag)) return true;
      var cls = typeof node.className === 'string' ? node.className : '';
      if (cls && SCAN_NOISE_CLASS.test(cls)) return true;
      var attr = node.getAttribute && node.getAttribute('contenteditable');
      if (attr === 'true' || attr === '') return true;
      try {
        var s = window.getComputedStyle(node);
        if (s && (s.display === 'none' || s.visibility === 'hidden')) return true;
      } catch (e) { /* ignore */ }
      node = node.parentElement;
    }
    return false;
  }

  /** 对话区：优先 <main>（侧边栏通常不在 main 里），没有就用 body */
  function chatRoot(root) {
    var main = root.querySelector && root.querySelector('main');
    if (main && textOf(main).trim().length > 20) return main;
    return root;
  }

  /** 去掉嵌套的重复：某个候选如果整段被另一个候选的文字包含，就丢掉 */
  function dropNested(list) {
    return list.filter(function (c, i) {
      return !list.some(function (other, j) {
        if (i === j) return false;
        if (!other.text.includes(c.text)) return false;
        // 文字更长（或同样长但更靠前）的那个胜出
        return other.text.length > c.text.length || (other.text.length === c.text.length && j < i);
      });
    });
  }

  /**
   * 通用提取：不依赖 .ds-markdown / .fbb737a4 这些类名，适合类名变了的时候。
   * 思路：以带文字的块级元素为候选，挑出正文块，去掉互相嵌套的重复，再按文档顺序输出。
   */
  function extractGeneric(rootOrDoc) {
    var base = rootOrDoc || document.body || document.documentElement;
    if (!base || !base.querySelectorAll) return [];
    var root = chatRoot(base);

    var nodes = Array.prototype.slice.call(root.querySelectorAll('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,div,section,article'));
    var candidates = [];

    nodes.forEach(function (el) {
      var tag = el.tagName;
      if (SCAN_SKIP_TAG.test(tag)) return;
      if (inChrome(el, root)) return;
      // 包着输入框的容器整块跳过
      if (el.querySelector('textarea,input,[contenteditable="true"]')) return;

      var own = textOf(el).replace(/\s+/g, ' ').trim();
      if (own.length < 2) return;
      candidates.push({ el: el, text: own });
    });

    if (!candidates.length) return [];
    candidates = dropNested(candidates);
    candidates.sort(function (a, b) { return comparePosition(a.el, b.el); });

    var out = [];
    var last = '';
    candidates.forEach(function (c) {
      if (c.text === last) return;      // 紧邻的完全重复，只留一条
      last = c.text;
      var text = textOfBlock(c.el);
      if (isBlank(text)) return;
      out.push({ role: guessRole(c.el), content: text });
    });
    return out;
  }

  /** 尽量从类名里猜说话人；猜不到就当助手 */
  function guessRole(el) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 6) {
      var cls = typeof node.className === 'string' ? node.className : '';
      if (/user|human|question|mine|self|right/i.test(cls)) return 'user';
      if (/assistant|bot|answer|reply|deepseek|markdown|response/i.test(cls)) return 'assistant';
      node = node.parentElement;
    }
    return 'assistant';
  }

  function comparePosition(a, b) {
    if (a === b) return 0;
    var rel = a.compareDocumentPosition && b.compareDocumentPosition ? a.compareDocumentPosition(b) : 4;
    if (rel & 4) return -1;   // FOLLOWING
    if (rel & 2) return 1;    // PRECEDING
    return 0;
  }

  window.DSExportRefine = {
    extractClean: extractClean,
    extractGeneric: extractGeneric,
    lastStats: function () { return lastStats; },
    _internals: {
      outermost: outermost,
      strictSignature: strictSignature,
      candidateFor: candidateFor,
      trimTrailingOptions: trimTrailingOptions,
      compactText: compactText,
      blockText: blockText,
      safeText: safeText,
      hasForeign: hasForeign,
      guessRole: guessRole,
      looksLikeThinking: looksLikeThinking,
      THINK_MARKER_RE: THINK_MARKER_RE
    }
  };
})();
