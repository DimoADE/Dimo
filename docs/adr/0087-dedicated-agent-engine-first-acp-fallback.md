---
status: accepted
date: 2026-11-14
decision-makers: Dimo maintainers
---

# Agent 接入与能力治理采用独立引擎适配优先、ACP 次选

## Context

Dimo 内置 20 个 Coding Agent 档案，并支持 ACP 官方 Registry 与用户声明分发。通用 ACP 包装器（如 `claude-agent-acp`、`codex-acp`）会折损主力 Agent 原生 SDK 与官方服务协议提供的一手控制面信号（精确 Token 与 Prompt Cache 过期计费、限流重置时间戳、原生在途纠偏、会话与代码协同回退、原生子代理流及细粒度权限钩子）；同时为全部长尾 CLI 逐一编写专属驱动亦不可持续。因此确立明确的主次双层接入与能力治理原则。

## Decision

1. **独立 Agent 引擎适配优先（首选）**：对核心或需深度发挥能力的 Coding Agent，优先在 `crates/agents` 内直接对接其官方 SDK、原生服务协议（如 `app-server` JSON-RPC）与原生配置/会话机制，构建独立 Agent 引擎驱动。已具备独立引擎适配的 Agent 直接走原生驱动，不再经由通用 ACP 包装进程中转。
2. **ACP 兼容接入为次选（兜底）**：Agent Client Protocol（ACP v1/v2，[ADR-0035](0035-acp-v2-dual-protocol-session-items.md)）作为标准兼容层与生态扩展通道，用于尚未提供独立引擎适配的内置 Agent、ACP 官方 Registry 条目与用户声明分发。
3. **管理与状态能力优先级**：当同一项认证、配额、模型目录、会话控制或状态探测能力同时可由独立引擎/原生本地适配与通用 ACP 提供时，**独立引擎与原生适配优先，ACP 为次选补缺**，不因迁就 ACP 通用字段而阉割原生能力。
4. **单一领域接缝不变**：独立引擎驱动与次选 ACP 适配器统一收敛于 `crates/agents`（`AgentRuntime`）内部，向 `crates/conversations` 与前端暴露一致的会话控制面、Turn 状态机与时间线投影；用户侧设置与工作区交互保持统一体验，且编码 Agent 绝不走 `crates/executors`。
5. **跨引擎通用 UI 与安全不变量**：无论底层走独立引擎还是 ACP 通道，所有 Agent 统一遵守三条基础约束：
   - **凭据掩码与不出宿主**：API Key、OAuth 令牌与敏感认证材料始终保留在 Rust 宿主与 Agent 原生配置中，前端仅展示脱敏/掩码态，永不回显明文密钥。
   - **订阅与配额只读展示**：订阅计划与配额信息仅以只读事实呈现，缺失字段保持缺失，不伪造默认值（[ADR-0058](0058-session-auxiliary-capability-honesty.md)）。
   - **事件驱动刷新**：安装状态、认证结果与会话能力变更经 `HostEventBus` 事件推送驱动 UI 刷新，不依赖常驻高频轮询。

## Consequences

- [ADR-0010](0010-agent-runtime-topology.md)、[ADR-0020](0020-built-in-agents-share-the-universal-pipeline.md) 与 [ADR-0034](0034-harden-acp-registry-and-adopt-auth-status.md) 中的 ACP 拓扑、握手与 Registry 规则适用于走次选 ACP 通道的 Agent，不再限制内置主力 Agent 拥有独立原生引擎驱动。
- 新增或深化 Agent 能力时，优先评估并落地官方 SDK / 原生服务协议适配；仅当目标 Agent 无可用原生接口或属于长尾生态时采用 ACP 通道。
- 凭据掩码、只读订阅展示与事件驱动刷新作为跨引擎统一基线持续生效，确保安全与体验一致。
