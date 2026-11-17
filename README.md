# DeepSeek 对话导出 · 精简版
# DeepSeek Chat Exporter · Lite

一个用于保存 DeepSeek 网页端已有对话的轻量浏览器扩展。适合备份聊天、整理资料，或把对话交给其他工具继续使用。

A lightweight browser extension for saving existing conversations from the DeepSeek website. Useful for backing up chats, organizing notes, or continuing your work in another tool.

## 中文介绍

作为 DeepSeek 的深度用户，我经常在手机端与它探讨问题、交流观点。但对话积累下来后，想把原文一次性导出成方便整理、长期保存的文本，或者交给桌面端的 AI 继续分析，并不方便。

尤其是讨论观点时，我希望保留完整的交流过程，而不只是最后的结论。因此，我做了这个小工具：在电脑上打开同一条 DeepSeek 对话，一键导出，方便之后保存、回顾和继续使用。

### 能做什么

- 一键导出当前打开的 DeepSeek 对话。
- 自动滚动页面，尝试加载并收集更早的消息。
- 按“第几轮、谁说的、说了什么”整理聊天记录。
- 获取到真实消息时间时一并显示，获取不到则省略。
- 保存为 `.md` 文件，可以用记事本或 Markdown 编辑器打开。
- 默认不附带接口字段、请求日志等无关数据，正文中的代码和网址仍会保留。

只有一种固定导出模式，无需选择格式或手动开启兜底选项。本扩展安装在电脑浏览器中使用，不是手机端插件。

### 安装方法

适用于 Chrome / Edge 等 Chromium 浏览器。

1. 在本仓库点击 **Code → Download ZIP**，下载后解压。
2. 打开浏览器扩展管理页：Chrome 为 `chrome://extensions/`，Edge 为 `edge://extensions/`。
3. 开启**开发者模式**。
4. 点击**加载已解压的扩展程序**，选择包含 `manifest.json` 的文件夹。
5. 打开 DeepSeek 网页并刷新一次。

### 如何使用

1. 打开你想保存的已有对话，等待回答生成结束。
2. 点击页面右下角的**导出对话 · 精简版**。
3. 点击**导出当前会话**。
4. 等待完成，在浏览器下载记录中找到 `.md` 文件。

也可以通过浏览器工具栏的扩展按钮导出。导出期间页面可能自动滚动，请不要切换对话。

```text
学习计划

第1轮 · 发言人1（我）：今天应该先学什么？

第1轮 · 发言人2（DeepSeek）：可以先复习昨天的内容，再做练习。

第2轮 · 发言人1（我）：练习多久比较合适？

第2轮 · 发言人2（DeepSeek）：可以先安排半小时。
```

### 常见问题

**没有看到导出按钮？**

确认扩展已启用，并刷新 DeepSeek 页面。更新扩展后，需要在扩展管理页点击“重新加载”，再刷新网页。

**导出需要等待一段时间？**

扩展可能正在向上滚动、加载和收集历史消息。较长的对话需要更久，请留意面板中的进度提示。

**没有显示发言时间？**

只有读取到真实消息时间、且能确认它对应哪条消息时才会显示。无法获取时会省略，不会用导出时间代替。面板会显示已获取时间的消息数量。显示的时间采用 UTC，北京时间为 UTC 加 8 小时。

**提示可能不完整，或者发现漏了消息？**

等待页面加载完成后重新导出，并检查开头、结尾和中间几轮。DeepSeek 页面结构、历史加载方式或内部接口变化都可能影响提取结果。

目前仍存在一些限制：

- 相同角色反复发送完全相同的内容，可能在页面采集时被去重。
- 修改提问、重新生成回复形成的分支尚未充分验证。
- 不导出附件原文件。
- 轮次按实际提取到的消息重新编号，编号连续并不代表历史一定完整。
- 滚动采集最多扫描 1200 屏；未确认到顶就停止时会提示。

如需反馈，请提供浏览器版本、扩展版本、复现步骤和脱敏示例，不要提交登录凭据或私人聊天全文。

### 隐私说明

内容整理在本地完成，扩展不会主动向第三方服务上传聊天数据。

为了读取历史，扩展可能使用当前网页的登录状态，请求 DeepSeek 自己的接口。因此它并非完全离线运行。导出文件保存在本机，分享前请检查其中是否包含私人信息。

### 实测与项目说明

我自己已经对三个不同的会话完成了三次导出，实测对话长度达到约 **21 万字**，检查后均未发现问题。

这是个人实际使用的结果，并非逐字自动比对或全面兼容性测试，不代表所有对话都能保证完整提取。

这是一个非官方、免费分享的小工具，主要围绕日常使用中验证过的导出方式进行精简。欢迎反馈问题或提交改进。

采用 [MIT License](LICENSE)。

---

## English

As a frequent DeepSeek user, I often use it on my phone to explore questions and discuss ideas. But once a conversation grows, saving the original exchange as a single text file for organizing, long-term storage, or further analysis with a desktop AI tool can be inconvenient.

When discussing ideas, I want to keep the full exchange, not just the final conclusions. That is why I made this small tool: open the same DeepSeek conversation on a computer and export it with one click, so it is easier to save, revisit, and reuse.

### What It Does

- Exports the currently opened DeepSeek conversation with one click.
- Automatically scrolls the page to try to load and collect earlier messages.
- Organizes the output by conversation round, speaker, and message content.
- Includes actual message timestamps when available; otherwise, omits them.
- Saves a `.md` file that can be opened in a text editor or Markdown viewer.
- Keeps API metadata and request logs out of the exported text while preserving code and links that are part of the conversation.

The extension uses one fixed export mode. No format selection or fallback configuration is required. It runs in a desktop browser; it is not a mobile extension.

**Note:** The current interface and exported speaker/round labels are in Chinese. Message content is preserved in its original language.

### Installation

Designed for Chromium browsers such as Chrome and Edge.

1. Click **Code → Download ZIP** in this repository and extract the archive.
2. Open `chrome://extensions/` in Chrome or `edge://extensions/` in Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Open the DeepSeek website and refresh the page.

### Usage

1. Open the conversation you want to save and wait for any response to finish generating.
2. Click **导出对话 · 精简版** in the bottom-right corner of the page.
3. Click **导出当前会话** to export the current conversation.
4. Wait for completion, then find the `.md` file in your browser’s downloads.

You can also export from the extension’s toolbar popup. The page may scroll automatically during export. Please avoid switching conversations while it is running.

### Troubleshooting

**The export button is missing**

Make sure the extension is enabled, then refresh the DeepSeek page. After updating the extension, click **Reload** on the extensions page and refresh the website again.

**The export takes a while**

The extension may be scrolling through the conversation and waiting for older messages to load. Longer conversations can take more time. Check the export panel for progress.

**Message timestamps are missing**

Timestamps are included only when actual message time data is available and can be matched to the correct message. Missing timestamps are omitted, never replaced with the export time. The panel reports how many messages have timestamps. Displayed timestamps use UTC.

**The export warns that it may be incomplete, or some messages are missing**

Wait for the page to finish loading and try again. Check the beginning, end, and a few rounds in the middle. Changes to DeepSeek’s page structure, history loading behavior, or internal APIs may affect extraction.

Known limitations:

- Identical messages from the same speaker may be deduplicated during page collection.
- Conversation branches created by editing prompts or regenerating responses have not been thoroughly tested.
- Original attachment files are not exported.
- Round numbers are generated from the extracted messages. Consecutive numbering does not prove that the entire history was captured.
- Scrolling is limited to 1,200 steps. A warning appears if collection stops without confirming that it reached the top.

When reporting an issue, include your browser version, extension version, reproduction steps, and a sanitized example. Do not share login credentials or private conversation logs.

### Privacy

Content processing happens locally. The extension does not actively upload conversations to third-party services.

To retrieve history, it may use your existing website login session to request data from DeepSeek’s own APIs. It is therefore not fully offline. Exported files are saved locally; review them for private information before sharing.

### Personal Testing and About This Project

I have personally completed three exports from three different conversations, with tested conversation lengths reaching approximately **210,000 Chinese characters**. I found no issues when checking these exports.

These are personal usage results, not character-by-character automated comparisons or comprehensive compatibility tests. They do not guarantee complete extraction for every conversation.

This is a small, unofficial, freely shared tool focused on a simple export workflow tested in everyday use. Bug reports and contributions are welcome.

Licensed under the [MIT License](LICENSE).

## 开发 / Development

扩展无需构建即可加载。离线测试需要 Node.js：

The extension can be loaded without a build step. Offline tests require Node.js:

```sh
npm test
```

DOM 测试需要可选依赖 `jsdom`，未安装时会跳过。DOM tests require the optional `jsdom` dependency and are skipped when it is unavailable.
