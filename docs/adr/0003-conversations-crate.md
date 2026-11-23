---
status: accepted
date: 2026-07-04
decision-makers: Dimo maintainers
---

# 会话领域独立成 `crates/conversations`

会话编排（Turn 生命周期、持久输入调度、启动恢复协调与时间线投影折叠）归属独立领域 crate `crates/conversations`，使存储层保持纯粹、宿主传输层保持薄委派。

## Decision

- `crates/conversations` 依赖 `crates/agents` 与 `crates/db`，作为事件溯源会话核心的唯一归属地。
- Turn 编排、启动恢复协调器（见 [ADR-0001](0001-crash-recovery-semantics.md)）、持久输入队列、Turn 纠偏以及 SQLite 事件到 `conversation_timeline_rows` 的单投影折叠与快照（见 ADR-0091）全部收敛于 `crates/conversations`。
- `crates/db` 保持纯数据访问层职责，不反向依赖 `crates/agents` 或会话业务规则。
- `crates/application` 与 `crates/server`（含桌面模式与无头守护进程）仅通过统一 `ApplicationCore` 接缝委派，不内联会话状态机。

## Considered Options

- **并入 `crates/agents`**：否决。`crates/agents` 专注 Agent 引擎适配、安装与运行时连接管理，混入会话事件溯源与时间线投影会模糊领域边界并导致模块膨胀。
- **并入 `crates/services`**：否决。`crates/services` 负责工作区、文件与外部集成基础设施，不应承载核心会话领域状态机。

## Consequences

- 依赖方向保持单向清晰：`server` / `application` → `conversations` → `agents` + `db`。
- 时间线更新统一经单投影协议（行 upsert 与文本追加操作）下发到所有客户端，不存在前后端双套投影逻辑。
