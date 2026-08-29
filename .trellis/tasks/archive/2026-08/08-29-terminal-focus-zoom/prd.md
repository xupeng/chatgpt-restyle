# 支持 Terminal 焦点缩放

## Goal

让现有 `Control` + `Shift` 缩放快捷键根据键盘焦点作用于正确区域：焦点位于 Terminal 时调整 xterm 字号，其他情况下继续缩放对话、Markdown 与 Plan 正文，避免用户在 Terminal 中操作却意外改变对话区比例。

## Background

- 当前缩放监听器注册在 `window` 捕获阶段，识别 `Control` + `Shift` + `=` / `-` / `0` 后始终更新正文缩放比例。
- 当前 ChatGPT Terminal 使用 `[data-codex-xterm]`，焦点元素是其内部的 `textarea.xterm-helper-textarea`，可通过 `document.activeElement.closest("[data-codex-xterm]")` 判断 Terminal 焦点。
- 当前待提交的 Terminal 字体适配已能取得对应 xterm 实例并同步其运行时 `fontFamily`；同一实例公开可更新的 `options.fontSize`。
- 正文缩放现有范围为 60%–160%，步长为 10%，支持重置、Toast、本地存储与跨窗口同步。

## Requirements

- `Control` + `Shift` + `=` / `-` / `0` 的按键定义保持不变。
- 焦点位于 `[data-codex-xterm]` 内部时，快捷键只调整该 Terminal 的 xterm 运行时字号，不改变正文缩放比例。
- 焦点不在 Terminal 时，现有正文缩放行为完全保持不变。
- Terminal 字号变化后必须触发 xterm 自身重新测量并调用其 FitAddon 重新适配面板尺寸，不能只用 CSS 缩放；放大后当前输入行和光标必须保持可见。
- Terminal 使用独立于正文的共享缩放比例，范围为 60%–160%、步长为 10%，由所有 Terminal 共用。
- Terminal 缩放比例使用独立的 localStorage 键持久化；新建 Terminal、其他任务窗口及重启后的 Terminal 自动应用该比例。
- `0` 将 Terminal 比例恢复为 100%，即恢复其主题提供的基础字号，而不是硬编码固定像素值。
- 字体/缩放功能被关闭、注入被清理或重新应用时，不得遗留错误的 Terminal 运行时状态。
- 用户可见提示使用中文，并明确区分 Terminal 与正文缩放。

## Acceptance Criteria

- [ ] Terminal 获得焦点后按增大/减小快捷键，所有已挂载 Terminal 按共享比例更新字号，正文比例保持不变。
- [ ] Terminal 获得焦点后按重置快捷键，Terminal 共享比例恢复为 100%，当前 Terminal 恢复主题基础字号。
- [ ] 焦点移出 Terminal 后，同一组快捷键继续按现有规则调整正文 60%–160% 比例。
- [ ] Terminal 和正文缩放均不会突破各自 60%–160% 范围，并显示对应中文 Toast。
- [ ] Terminal 在 120% 及更高比例下会重新 fit 到面板宽度，当前输入行与光标保持可见。
- [ ] 新建、重新挂载或其他窗口中的 Terminal 自动应用独立持久化的共享比例。
- [ ] 清理注入会恢复 xterm 原始字号和字体；重新注入不会累积缩放。
- [ ] 自动化测试覆盖焦点路由、增减、上下限、重置、正文互不干扰及清理恢复。
- [ ] `npm test` 与 `./scripts/doctor-macos.sh` 通过，并在当前打开的 ChatGPT Terminal 中完成实时验证。

## Out Of Scope

- 修改 ChatGPT/Codex 自带的 `Command` + `+` / `-` 整窗缩放。
- 增加新的设置界面或 `.env` 配置项。
- 同时缩放 Terminal 面板尺寸、标签栏或其他 UI chrome。
- 修改 Terminal 主题颜色、行高或 shell 配置。

## Key Decisions

- Terminal 缩放独立持久化，并由所有 Terminal 共用。
- Terminal 与正文采用相同的 60%–160% 范围和 10% 步长，但分别保存比例，互不影响。
