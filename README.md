# Antigravity–Codex Bridge

让同一台电脑上的 Antigravity 和 Codex 会话互发消息。任务交接、进度更新和验收结果都可以直接发往对方会话。

## 安装

准备 Node.js 20+、Antigravity（含 `agy` 命令）和 Codex CLI。安装流程已在 macOS 验证。

```bash
git clone https://github.com/Rowan314/antigravity-codex-bridge.git
cd antigravity-codex-bridge
agy plugin install .
node scripts/install.mjs --codex
```

安装后保留克隆目录，然后在两个客户端各开一个新会话。

## 使用

在任意一端的主会话里直接说：

- 「用桥接把这段进展发到 Antigravity 的『项目验收』会话。」
- 「用桥接把这项任务发到 Codex 的『项目开发』聊天。」
- 「把验收结果通过桥接回给发来任务的会话。」

## 常见问题

- **找不到桥接工具**：刷新客户端的 MCP 工具，或新开会话后让助手运行 `bridge_doctor`。Antigravity 里的服务器名是 `antigravity-codex-bridge_bridge`。
- **显示 `submitted`，对方还没看到**：打开目标会话核对。如果消息进入 Codex 队列，可以在目标聊天查看排队状态。Antigravity 的消息正文可在 `Bridge message from Codex` 卡片里展开。
- **诊断提示 Codex daemon 未运行**：在终端执行 `codex app-server daemon start` 后再试。

## 卸载

```bash
agy plugin uninstall antigravity-codex-bridge
codex mcp remove antigravity-codex-bridge
```

## 参考项目

跨会话双向通信的设计参考了 [KeeVeeG/claude-codex-bridge](https://github.com/KeeVeeG/claude-codex-bridge)。

许可证见 [MIT](LICENSE)。
