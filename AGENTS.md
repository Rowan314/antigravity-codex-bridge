# Antigravity–Codex Bridge (`AGENTS.md`)

本仓库是双端共享的零依赖 Node.js MCP 插件，用于运行中的 **Antigravity** 与 **Codex** 会话之间进行本地异步双向通信。

## 核心约束

- **零外部 npm 依赖**：仅使用 Node.js 20+ 内置模块（`node:*`）。
- **禁止绑定版本号**：不比对任何客户端/服务端版本号，不使用版本号条件分支；全部采用运行时能力探测与官方公开接口。
- **单文件上限**：每个源文件不超过 500 行，按单一职责拆分目录。
- **单向依赖方向**：`scripts/` -> `lib/service/` -> `lib/transports/` + `lib/state/` + `lib/core/`。

## 目录结构

```text
antigravity-codex-bridge/
├── plugin.json                 # Antigravity 插件清单
├── mcp_config.json             # Antigravity MCP Server 声明
├── hooks.json                  # Antigravity 生命周期 Hook（端点注册 + 调用方识别）
├── .codex-plugin/plugin.json   # Codex 插件清单
├── skills/bridge/SKILL.md      # 双端共享的 Agent 使用指南
├── scripts/
│   ├── mcp.mjs                 # 标准 stdio MCP JSON-RPC 2.0 服务入口
│   ├── run-mcp.sh              # 跨 PATH Node 启动包装器（兼容 macOS GUI 进程）
│   ├── agy-hook.mjs            # Antigravity Hook 入口
│   └── install.mjs             # 双端安装/卸载与本地注册管理
├── lib/
│   ├── core/                   # 结果模型、消息信封、调用预算、WebSocket、本地 Socket
│   ├── state/                  # 状态目录、跨进程文件锁、主机注册表、幂等投递账本
│   ├── transports/             # Antigravity HTTP/agentapi 与 Codex daemon/queue/desktop 适配
│   └── service/                # 调用方身份识别、Codex 路由、只读诊断与桥接工具编排
└── test/                       # 基于 node:test 的自动化测试套件
```

## 常用命令

```bash
# 运行全部自动化测试
npm test

# 校验 Antigravity 插件结构
agy plugin validate .

# 安装/检查双端插件注册
node scripts/install.mjs --dry-run
node scripts/install.mjs
```

面向用户的安装命令、投递状态和卸载步骤见 [README.md](README.md)。工作日志追加到本机根目录的 `WORKLOG.md`。
