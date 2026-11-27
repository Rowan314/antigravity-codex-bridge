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

- 「把已批准的任务派到对端的同一项目，新建会话并发送，完成后回传本会话。」

- 「用桥接把这段进展发到 Antigravity 的『项目验收』会话。」
- 「用桥接把这项任务发到 Codex 的『项目开发』聊天。」
- 「把验收结果通过桥接回给发来任务的会话。」

### 在对端项目中开新会话

新任务使用 `dispatch_to_codex` 或 `dispatch_to_antigravity`。传入对端 `project_id`、会话 `title`、任务 `message`、可核查的 `authorization_ref` 和唯一 `message_id`。Antigravity 的项目 ID 可从对端已有主会话的发现结果核实，Codex App 的项目 ID 以项目目录对应的原生项目记录为准。

成功回执包含新会话 ID。同一发件会话使用相同 ID 和内容重试时，已完成的派单直接返回原回执。遇到 `delivery_unconfirmed` 时，先用 `list_deliveries` 和对端会话列表核对。优先使用回执中的会话 ID，缺失时核对候选会话首条桥接消息的 `message-id`。已有会话投递和结果回传继续使用 `send_to_codex` / `send_to_antigravity`。

新建 Codex 对话在 macOS 上优先通过官方 `codex://threads/new` 深链与 macOS 辅助功能界面核验完成（需在系统设置中为 Antigravity 开启「辅助功能」权限，且 Codex App 与本地 `codex app-server daemon` 处于运行状态）；提交前会核对本地项目、`gpt-6.2-sol`、`high` 和标准速度（`fast=false`）及编辑框内容。入口不可用、权限受限或设置无法核实时，会保留待发送草稿并返回具体原因，已有会话收发不受影响。`bridge_doctor` 会分别报告 `existing_sessions`（已有会话收发）和 `native_dispatch`（原生新建派单）状态。新建 Antigravity 对话使用原生 `agentapi new-conversation`，要求对端已有可核实的项目主会话。

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
