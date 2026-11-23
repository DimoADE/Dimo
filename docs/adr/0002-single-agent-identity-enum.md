---
status: accepted
date: 2026-07-04
decision-makers: Dimo maintainers
---

# Agent 身份收敛为 `crates/api-types` 中的单一枚举 `AgentKind`

Agent 身份在全仓库统一为单一编译期枚举 `AgentKind`，避免多套并行枚举通过字符串匹配桥接导致新增 Agent 时漏改。

## Decision

- `AgentKind` 定义在共享叶子 crate `crates/api-types` 中，供 `crates/agents`、`crates/conversations`、`crates/db`、`crates/application` 与前端生成类型共同引用。
- 序列化采用数据库持久化的 `snake_case` 键（如 `claude_code`、`codex`），读边界保留对历史大小写格式（SCREAMING / Pascal）的宽容解析。
- `QaMock` 作为枚举的常驻变体存在：`qa-mode` Cargo feature 仅门控 mock 运行时的可用性，不条件编译枚举变体，避免 serde 与 TypeScript 类型导出漂移。
- `registry_id`（如 `claude-acp`）属于 ACP Registry 条目元数据，与内置身份枚举分离，保留在 registry 层。
- `crates/executors` 仅保留工作区生命周期脚本与日志归一化辅助，不运行任何 Coding Agent；历史会话导入统一归于 `conversation_imports`。

## Considered Options

- **新建专用叶子 crate 仅存放 `AgentKind`**：否决。仅为单个枚举增加 workspace 成员会徒增包图复杂度。
- **让 `crates/executors` 反向依赖 `crates/agents`**：否决。与 `crates/executors` 退出 Agent 运行路径的边界相悖，并会向下游传播重依赖。

## Consequences

- 新增内置 Agent 时，Rust 编译器与 TypeScript 穷举检查可立即定位所有缺失分支。
- 动态 Registry Agent 与用户声明 Agent 使用开放的 `AgentId` 表示，内置成员与 `AgentKind` 保持一一映射。
