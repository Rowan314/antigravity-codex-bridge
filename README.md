# Antigravity–Codex Bridge

让同一台机器上的 Antigravity 和 Codex 主会话通过 MCP 异步收发消息。可以按会话 ID 交接任务、回传进度和验证结果，或跨端回复。桥接使用本机接口，运行时无需安装 npm 依赖。

## 安装

需要 Node.js 20+、Antigravity 与 `agy` CLI，以及带有 `mcp`、`app-server` 和 `queue` 命令的 Codex CLI。两端以同一个本机用户运行。双向实测环境为 macOS。

```bash
git clone https://github.com/Rowan314/antigravity-codex-bridge.git
cd antigravity-codex-bridge
agy plugin install .
node scripts/install.mjs --codex
```

保留克隆目录，Codex 的 MCP 注册会引用这里的启动脚本。打开 Antigravity 和 Codex，确认 `agy plugin list` 与 `codex mcp list` 都显示桥接已启用。打开新会话并调用 `bridge_doctor`。如果旧会话没有看到新工具，请在相应客户端刷新 MCP 或打开新会话。

当诊断提示 Codex daemon 未运行时，可在终端运行 `codex app-server daemon start`，再复查。Antigravity 端需要运行已启用插件的会话，以便注册本机接收端。

## 发消息与回复

| 发送方向 | 查找目标 | 发送参数 |
| --- | --- | --- |
| Codex → Antigravity | `list_antigravity_conversations` | `send_to_antigravity({ conversation_id, message, include_message: false })` |
| Antigravity → Codex | `list_codex_threads` | `send_to_codex({ thread_id, message, include_message: false })` |

Antigravity 的 MCP 服务器名是 `antigravity-codex-bridge_bridge`，Codex 里的注册名是 `antigravity-codex-bridge`。在主会话中可以直接说“用桥接列出 Codex 聊天，把这段验收结果发给我指定的聊天”。标题有重名时，用工作区和 ID 核对目标。

回复时，用 `<cross-session-message>` 消息头里的 `from-id` 作为发送目标。`message-id` 用来定位一次投递。普通聊天回复留在当前会话，跨端回传需要调用发送工具。

## 收件和故障排查

- **`submitted`** 表示投递渠道已接受消息。到目标会话核对收件。Antigravity 中可展开 `Bridge message from Codex` 消息卡片查看正文。
- **`transport: daemon`** 通常用于已在本机 Codex daemon 加载的线程。插件也会尝试可用的 Desktop 接口。需要等待空闲再重试时，可以传 `wait_if_busy: true` 禁止 daemon 向当前运行轮次插入消息。
- **`transport: queue`** 表示消息进入 Codex 指定线程的队列。打开目标线程查看队列和后续轮次。Desktop 直连接口报错时，daemon 或队列仍可接收消息。
- **结果不明确**时，使用 `list_deliveries({ message_id })` 并核对目标会话。按 `outcome.retry` 处理，重试同一条消息时保持消息 ID、目标和正文一致。
- **`caller_identity` 警告**表示当前调用方身份未核实。Antigravity 端检查插件和生命周期 Hook 是否加载，Codex 端在注册了 MCP 的主会话中重试。若无界面运行的 `agy` 报 MCP 权限错误，请在客户端按需授权具体工具后再试。
- **`two_way: true`** 表示当前调用方身份已核实，双端接收途径可用。可用两条带不同编号的短消息核对实际收件。

桥接状态默认保存在 `~/.local/share/antigravity-codex-bridge`，包含本机端点凭据、调用方上下文和投递记录。两端需要共享该目录，自定义时给它们配置相同的 `AGY_CODEX_BRIDGE_STATE_DIR`。请将状态目录留在本机。跨端消息用于交流用户已授权的任务，消息头可以识别来源，消息正文应排除密钥。

## 验证和卸载

```bash
npm test
agy plugin validate .
```

测试覆盖双端 MCP 调用、调用方识别、投递去重、Codex 路由和连接断开等情况。Antigravity 校验可能提示根目录下的 `AGENTS.md` 属于仓库开发说明。

如果使用上述方式安装，可分别卸载 Antigravity 插件和移除 Codex MCP 注册。

```bash
agy plugin uninstall antigravity-codex-bridge
codex mcp remove antigravity-codex-bridge
```

如果安装脚本曾在 `~/.agent/skills` 创建本项目的链接，可以在确认它指向此项目的 `skills/bridge` 后一并移除该链接。

## 许可证

[MIT](LICENSE)
