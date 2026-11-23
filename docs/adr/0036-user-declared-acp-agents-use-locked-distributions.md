---
status: accepted
date: 2026-08-05
decision-makers: Dimo maintainers
---

# 用户声明的 ACP Agent 复用版本锁定安装管线

除 Built-in Agent Profile 与官方 ACP Registry 之外，Dimo 支持 **User-declared agent definition（用户声明 Agent 定义）** 作为第三种受控 Agent 来源，使未收录进官方 Registry 的内部 Agent、开发中 Agent 或 fork 能在同一完整性与安装锁边界内接入。

## Decision

### 1. 受限的声明格式与不可变身份

- 仅接受符合 ACP Registry `distribution` 结构的 Binary、`npx` 或 `uvx` 声明；拒绝任意本地 shell 启动命令、PATH 自动接管、远程 ACP URL、自定义 Registry URL 以及每次启动无锁临时下载执行。
- 每条用户声明定义包含：不可变且全局唯一的稳定 `AgentId`、显示名、简介、语义版本、明确选择的分发方式、对应 distribution 数据，以及基于规范化定义计算的 SHA-256 digest。
- 保存定义与写入 membership 在同一数据库事务中原子完成：新 Agent 立即默认启用并进入 Agent 导航带；不得覆盖任何内置或已有 `AgentId`；安装失败、取消或中断不撤销 membership。

### 2. 冻结安装计划与启动完整性

- 安装前，Application Core 独立执行与官方 Registry 相同的结构、平台、URL、包版本与 SHA-256 校验（不信任前端单侧校验）。`npx`/`uvx` 必须锁定精确版本；Binary 优先校验声明的预期 SHA-256，缺省时沿用 TOFU 策略（见 [ADR-0017](0017-binary-integrity-has-two-trust-levels.md)）。
- 所选分发在创建操作时冻结至 `FrozenInstallPlan` 与 `InstallationLock`（记录 `user_definition` 来源与 definition digest），不允许失败后静默切换分发方式；后续编辑定义不篡改已排队或已安装的版本。
- 每次建立 ACP 连接均经过统一的 `LaunchGate` 与内容哈希验证（见 [ADR-0034](0034-harden-acp-registry-and-adopt-auth-status.md)）。

### 3. 独立投影与诚实来源标识

- 官方 Registry catalog 与用户声明定义保持两个独立投影：用户声明 Agent 不写入官方 Registry snapshot，不受 Registry 在线状态或 freshness 限制，在界面中标示为“用户提供”，严禁展示“官方 Registry”或“Dimo 已验证”徽标。
- 手动添加入口采用设置页内联表单并提供字段级可修复错误提示；Agent 导航带、详情页、状态模型与会话管线与其它 Agent 完全统一。
- 移除用户声明 Agent 时删除 Dimo 拥有的定义记录与安装元数据，保留其创建的历史 Conversation（见 [ADR-0014](0014-built-in-agents-are-permanent-members.md)）。

## Considered Options

- **允许任意可执行路径与命令行参数**：否决。无法形成可复现安装锁，并显著扩大 PATH 劫持与任意进程启动风险。
- **将用户定义混入官方 Registry snapshot**：否决。破坏官方来源真实性、离线 freshness 与上游下架语义。
- **每次启动临时运行 `npx`/`uvx` latest**：否决。破坏精确版本锁定、生态完整性与可复现修复。

## Consequences

- 三类受控来源（内置 Profile、官方 Registry、用户声明）共享统一的锁、校验与启动门禁，用户声明来源的真实性由用户自行负责。
- 用户声明 Agent 通过通用 ACP 事件日志留存 Dimo Conversation 历史，不获得绕过白名单的专属账号动作或原生配置特权。
