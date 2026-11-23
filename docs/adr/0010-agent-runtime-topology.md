---
status: accepted
date: 2026-07-28
decision-makers: Dimo maintainers
---

# 本地 Agent Runtime 拓扑：独立原生引擎优先，ACP 分原生与适配器两类

Dimo 的 Agent 运行时采用**独立原生引擎适配优先，ACP（v1/v2 + 官方 Registry）为次选兼容通道**的拓扑模型（详见 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)），并依托用户本机环境解析与安装（详见 [ADR-0060](0060-agent-installs-use-user-environment.md)）。

## Decision

### 1. 独立原生引擎（首选）

- 具备独立引擎驱动的内置 Agent 在 `crates/agents` 内直接对接官方 SDK 或原生协议（如 `app-server` JSON-RPC）以及原生状态/配置/认证，不绕行 `*-acp` 包装包。
- 预检查与启动门禁直接验证并拉起该原生引擎，保留一等控制面保真度。

### 2. ACP 次选通道的两种本地拓扑

在走 ACP 兼容通道的 Agent 中，Built-in Agent Profile 明确区分两类拓扑：

- **`NativeAcp`（原生 ACP）**：同一可执行安装物同时提供 Agent Runtime 与 ACP 服务。
- **`AdapterBacked`（适配器型 ACP）**：独立的本地 ACP 适配器桥接其底层 Agent Runtime。

对于自带 vendor CLI 分发的适配器型内置 Agent（如回退到 `claude-agent-acp` / `codex-acp` 时）：

- 会话启动与安装状态仅验证 ACP 适配器启动命令能否在用户环境（`PATH`、npm 全局前缀等）中解析并完成握手。
- `PATH` 上的 vendor CLI 仅作为可选本地证据（诊断与原生配置目录），不是会话启动门，也不得通过 `CLAUDE_CODE_EXECUTABLE` 或 `CODEX_PATH` 强制注入，安装时亦不额外写入独立 vendor CLI 包。
- 对于 `pi-acp` 等由适配器自行解析底层 CLI 的 Agent，宿主只验证适配器入口；自定义底层命令路径属于配置项，不作为预检查健康门。

### 3. 受控来源与本地进程边界

- Agent 来源限定为三种受控途径：随发布内置的 Built-in Agent Profile、官方 ACP Registry 条目，以及符合 [ADR-0036](0036-user-declared-acp-agents-use-locked-distributions.md) 的用户声明 ACP 定义。
- Built-in Agent Profile 随 Dimo 应用版本发布更新，不得从远端动态下载或覆盖其运行拓扑、检测规则、版本组合或完整性基线。
- 普通 Registry Agent 默认视为自包含的本地 runtime，必须完成本地安装与可执行文件/ACP 握手验证后方可使用；若实际依赖 manifest 未声明的外部 runtime，预检失败即标为不支持，不为单个 Registry 条目补写专属适配。
- ACP 通道仅启动在本机运行的 `stdio` 进程（Binary、`npx`、`uvx`），并依赖可复核的本地安装锁；不接受远程 ACP URL、HTTP/WebSocket 端点、任意自定义启动命令，也不允许每次启动时无锁临时下载执行。

## Consequences

- 原生引擎与 ACP 通道共享同一产品生命周期与会话控制面，而底层协议差异被收敛在 `crates/agents` 内。
- 用户在自身环境通过官方方式安装的 CLI 或适配器可直接被探测和复用，无需维护隐蔽的 Dimo 私有 Agent 运行树或 shim 层。
