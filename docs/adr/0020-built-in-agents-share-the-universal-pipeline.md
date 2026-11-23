---
status: accepted
date: 2026-07-29
decision-makers: Dimo maintainers
---

# 内置 Agent 与其他 Agent 共享统一产品管线

所有 Agent——无论来自 20 个预置 Built-in Agent Profile、官方 ACP Registry 还是用户声明定义（[ADR-0036](0036-user-declared-acp-agents-use-locked-distributions.md)）——在产品层共享同一套状态模型、设置页面骨架、预检查、安装、认证、配置、诊断与会话控制面。

## Decision

### 1. 统一产品管线与分层运行时接入

- 三种受控来源均提供归一化的声明数据，进入同一安装、状态投影、诊断与会话管理管线。
- 底层运行时遵循**独立原生引擎适配优先、ACP 通道次选**（见 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）：具备独立引擎驱动的内置 Agent 直接对接官方 SDK 或原生协议，无独立引擎的内置 Agent、官方 Registry Agent 与用户声明 Agent 统一走 ACP 兼容通道。
- “内置”身份仅决定默认加入导航带、Registry 置顶、不可移除（[ADR-0014](0014-built-in-agents-are-permanent-members.md)）、主动探测本地安装以及通过统一扩展接口声明 Profile 级适配 Provider；不能为单个内置 Agent 衍生专属设置页面、独立状态机或硬编码会话能力。

### 2. 统一详情页骨架与反馈契约

- 所有 Agent 详情页采用状态驱动的统一分组结构：顶部摘要与启用控制、预检查、运行环境与安装、认证与账户、配置、诊断与高级操作。
- 非就绪或存在进行中操作时自动展开预检查区，就绪后折叠为摘要；未被协商广告的可选能力不渲染且不视为失败。
- 操作结果通过 Toast 即时反馈，不在详情页顶部堆叠错误条：成功 Toast 自动收起，失败 Toast 保持至用户关闭并提供“查看”入口定位对应预检查失败项。
- 诊断区为每个 Agent 保留最近 20 次安装、更新、修复与探测记录，支持单独清除与导出；所有诊断输出中的 API Key 与令牌在后端强制脱敏。

## Consequences

- 新增内置或第三方 Agent 时只需补充声明式 Profile 或遵循公共接口，无需复制设置界面或会话编排逻辑。
- 历史导入、模型与供应商配置、账号动作等能力均通过明确声明的统一机制暴露，避免因“内置”标签产生隐式特权或不一致体验。
