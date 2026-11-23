---
status: accepted
date: 2026-07-04
decision-makers: Dimo maintainers
---

# 会话分叉：复制事件至分叉点并按能力分叉 Agent 上下文

会话分叉（Session Fork）创建一个完全独立的新 `Conversation`（作为一等 Dockview 面板），不与父会话共享历史读取路径；在 Agent 支持分叉能力时同步分叉其原生或 ACP 侧上下文。

## Decision

### 1. 独立历史副本

- 分叉在 SQLite 单权威存储（ADR-0091）中将父会话截至分叉点的事件日志完整复制到新会话，写入新会话独立的 sequence 空间与幂等键域；父子会话在读取、截断、投影与导出路径上完全解耦。
- 亲子关系仅作为导航与展示元数据保存（`ConversationRelation(fork)`，含 `forked_from_conversation_id` 与 `fork_point_turn`），不参与任何历史读取拼接。
- 产品切点为一条**已完成**的 Assistant 气泡所属的 Dimo Turn（省略切点时默认为尾部最后一个 Assistant，含在途检查）；该 Turn 及其之前的全部事件（含工具调用、权限与计划）完整复制到子会话，父会话保持不变。
- 若省略切点且最新 Turn 仍在途，或目标 Turn 在途，拒绝分叉（`fork_turn_in_flight`），不复制半成品 Turn。

### 2. Agent 上下文连续性

- **尾部切点**：当 Agent 在当前引擎或 ACP `initialize` 能力中广告了 fork 能力（如原生引擎分叉或 ACP `session/fork`）时，向 Agent 发起分叉获得独立新会话 `S2`，子会话绑定到 `S2`（下次发送先恢复/加载 `S2`），父会话继续保留原绑定不改挂 `S2`。
- **历史切点（支持切点命名）**：当 Agent 支持按切点定位历史 Assistant（如 AIR `_meta.jetbrains.air.fork` 或 Claude `messageId` + fingerprint + occurrence）时，携带切点信息发起 Agent 侧分叉。
- **未命名的非尾部切点**：若目标切点无法被命名定位，直接拒绝创建子会话（`fork_point_unnamed`），禁止发出尾部 `session/fork` 导致 Agent 上下文长于可见历史。
- **降级记录**：仅在合法创建子会话后 Agent binding 或 `session/fork` 调用失败（或 Agent 未广告 fork 能力进行尾部降级）时，子会话降级为 `history_only` 并在关系元数据中明示，由用户以冷启动方式继续对话。

### 3. 面板行为

- 分叉成功后，新 `Conversation` 作为一等 Dockview 面板打开，当前视图焦点切换到子会话面板，父会话不被强制关闭或转入后台监控。

## Considered Options

- **引用父日志（Copy-on-Write）**：否决。父会话截断（reset-to-here）会物理删除父事件，引用语义需要复杂的级联保护，并迫使投影、搜索索引与导出路径维护跨会话拼接分支。
- **冷启动新会话并将历史文本塞入首条 Prompt**：否决。丢失工具调用与权限结构，Agent 侧缺乏真实会话状态，且重复消耗大量 Token。

## Consequences

- 共同前缀在 SQLite 中存储两份，但换取了完全独立的读写与截断语义；时间线投影行可随时从子会话事件重建。
- 复制事件时必须重写 sequence 与幂等键，禁止跨会话复用原幂等键。
- 会话分叉与破坏性截断（reset-to-here）互为补充，各自保持清晰边界。
