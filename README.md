# ChatGPT Restyle

ChatGPT Restyle 是一个修改 ChatGPT Desktop 对话区域、右侧 Markdown 文件预览
及 Plan 正文排版的个人 macOS 工具。它不会修改应用安装包、
`~/.codex/config.toml`、Appearance 设置、侧栏、顶部区域、输入框、队列消息或
其他文件预览。

## 要求

- macOS
- 官方 ChatGPT Desktop（Bundle ID 为 `com.openai.codex`）
- 已安装 `LXGW WenKai Screen`

工具不会自动下载或安装字体。

## 默认排版

- 正文：`LXGW WenKai Screen`，`16px`，字重 `500`，行高 `1.75`
- 块间距：`0.75em`
- 消息间距：`24px`
- 代码：优先使用 `Cascadia Code`，未安装时回退到 ChatGPT 原生代码字体

## 使用

推荐在 Raycast 中运行 **ChatGPT with Restyle**。Script Command 位于：

```text
raycast/chatgpt-with-restyle.sh
```

Raycast 的 Script Commands 目录应包含：

```text
<chatgpt-restyle 项目目录>/raycast
```

也可以直接使用项目根目录的命令：

- `Apply.command`：启动或重新应用排版
- `Status.command`：检查进程、端口、renderer 和字体状态
- `Restore.command`：移除排版并按普通模式重新启动 ChatGPT

运行状态和日志位于：

```text
~/Library/Application Support/ChatGPTRestyle
```

## 自定义排版

编辑 [`assets/chat-typography.css`](./assets/chat-typography.css) 顶部的 CSS
变量。ChatGPT 已由 ChatGPT Restyle 启动时，保存文件后会自动热更新。

## 正文缩放

ChatGPT Restyle 可以统一缩放对话正文、Markdown 文件正文和 Plan 正文，不改变
输入框、队列消息、侧栏、顶部栏或面板 chrome：

- `Control` + `Shift` + `+`：放大 10%
- `Control` + `Shift` + `-`：缩小 10%
- `Control` + `Shift` + `0`：恢复 100%

缩放范围为 60%–160%。当前比例会短暂显示在页面底部，并由 ChatGPT 的本地存储
保存；所有任务、正文区域和标签页共用同一比例，刷新或重启后仍会保留。
`Restore.command` 只移除当前注入效果，不删除已保存的比例。ChatGPT 原有的
`Command` + `+` / `-` 整窗缩放快捷键保持不变。缩放只改变正文内容的显示比例和
换行，不会扩大对话、Markdown 预览或 Plan 正文列的视觉宽度。

## 功能开关

可以在项目根目录的 `.env` 中分别启用或关闭整套自定义排版与正文缩放：

```dotenv
CHATGPT_RESTYLE_FONT_ENABLED=true
CHATGPT_RESTYLE_ZOOM_ENABLED=true
```

两个配置缺省时均为 `true`，且只接受小写的 `true` 或 `false`。字体开关控制
字体、字号、字重、行高、间距和代码样式；缩放开关控制正文 zoom、快捷键和比例
Toast。关闭缩放不会删除已保存在 ChatGPT localStorage 中的比例。

修改功能开关后，再次运行 Apply 或 Raycast 命令即可在当前 CDP 会话生效；
ChatGPT 不会重启。后台 watcher 会在配置变化时原地更新，继续处理页面重载和
任务切换。

## 配置固定端口

默认情况下，每个新的 ChatGPT Restyle 会话都会随机选择 CDP 端口。如需使用固定
端口，将示例配置复制为项目根目录的 `.env`，并设置：

```dotenv
CHATGPT_RESTYLE_PORT=54321
```

端口必须是 `1024–65535` 中当前未被占用的整数。配置无效、重复或端口已被占用时，
Apply 会明确报错，不会回退到随机端口。`.env` 只在新的 ChatGPT Restyle 会话启动
时决定端口；已有会话会继续使用当前端口，修改后的端口将在下次启动时生效。

## 常见问题

### CDP 端口是 ChatGPT 默认端口吗？

不是。ChatGPT 默认不会开放 CDP。未配置 `.env` 时，每次创建新的 ChatGPT Restyle
会话都会在 `49152–65535` 中随机选择端口；配置 `CHATGPT_RESTYLE_PORT` 后则使用
指定端口。两种方式都只监听 `127.0.0.1`。

### 是否有后台 daemon 持续运行？

启用后会运行一个后台 watcher，负责处理页面重载、任务切换和 CSS 热更新。
它通过一次性的 per-user launchd submitted job 启动，不安装 LaunchAgent，也不会
随登录自动启动。这样 watcher 不依赖启动它的 Raycast、Finder 或终端进程继续存活，
日志也由 launchd 直接写入状态目录。退出 ChatGPT 后，watcher 会在确认启动时记录的
ChatGPT 主进程已经结束后自动退出，临时 launchd job 随之结束，并删除属于自己的
运行状态；执行 `Restore.command` 时也会按记录的 launchd label 结束 watcher。

### 是否会破坏 ChatGPT App 的签名？

不会。工具只通过 CDP 在 renderer 内存中插入样式，不修改 `.app`、`app.asar`
或 ChatGPT 配置文件。Apply、Status 和 Restore 还会在操作前只读校验 ChatGPT
App 及其内置 Node runtime 的签名。

### ChatGPT 升级后需要修改工具吗？

通常不需要。升级或重启后重新运行 Apply 或 Raycast 命令即可。只有 ChatGPT
改变对话区域 DOM、Bundle ID、内置 Node 路径或 CDP 启动行为时，工具才需要
相应适配。

### 每次启动 ChatGPT 都必须通过 Apply 或 Raycast 吗？

需要样式时，是的。CDP 必须在 ChatGPT 进程启动时开启，因此每个新的 ChatGPT
进程都应通过 Apply 或 Raycast 命令启动。

### 普通启动 ChatGPT 为什么不会应用样式？

普通启动不会带上 ChatGPT Restyle 需要的 CDP 参数，injector 无法连接 renderer，
所以界面保持官方样式。此时运行 Apply 会先询问是否重启 ChatGPT。

### 同一已启用会话修改 CSS 是否需要重启？

不需要。后台 watcher 会监控 `assets/chat-typography.css`，保存后自动重新注入。

### 如何通过 Raycast 启动？

在 Raycast 中搜索并运行 **ChatGPT with Restyle**。它使用 `silent` 模式直接
执行项目中的 `scripts/apply-macos.sh`：成功启动后不会留下 Raycast 输出窗口，
也不会额外打开 `.command` 文件。

## 安全边界

随机端口只能降低被直接猜中的概率，固定端口和随机端口都不能为 CDP 提供身份验证。
本机其他进程仍可能访问或扫描 loopback listener。不使用排版功能时，运行
`Restore.command` 关闭 injector 和 CDP 会话。

## 开发与检查

```bash
npm test
./scripts/doctor-macos.sh
```

doctor 会检查项目文件、Shell/Node 语法、ChatGPT App 签名和内置 Node runtime，
但不会重启 ChatGPT。

## 当前版本边界

工具只支持当前 ChatGPT App，不保留旧版应用或旧 Markdown renderer 的兼容分支。
样式只匹配对话流、文件面板中由 CodeMirror 承载的 Markdown 文件正文，以及
Plan 标签页的 Markdown 正文：

```text
main[data-app-shell-main-surface] .thread-scroll-container
  [data-user-message-bubble="true"] [class*="_MarkdownRoot_"]
main[data-app-shell-main-surface] .thread-scroll-container
  [data-markdown-text-style="assistant-message"]
main[data-app-shell-main-surface] [role="tabpanel"][aria-label$=".md"] .cm-editor
[role="tabpanel"][aria-label="Plan"] [class*="_markdownContent_"].text-size-chat
```

ChatGPT 更新后如果该结构变化，需要根据当前 renderer DOM 更新选择器和测试。
