---
status: accepted
date: 2026-08-13
decision-makers: Dimo maintainers
---

# 会话控制面统一持久输入、运行中纠偏与父子关系

Dimo 将 Conversation 的创建、普通输入、延时输入、运行中纠偏、等待、取消与父子导航收敛到 `ApplicationCore` 内的单一会话控制面 `ConversationControl`；所有历史与控制面事实均以 SQLite 单权威存储为准（ADR-0091），桌面、Web、远程 Workstation、移动端、CLI、SDK、`dimo-mcp` 与 Workflow 必须共同经由该控制面操作会话。

## Decision

### 1. `ConversationControl` 是唯一写入口

`ApplicationCore` 提供传输无关的深模块 `ConversationControl`，公开语义接口如下（不暴露传输层、SQLite 或 React 类型）：

```text
create(input, operation_id) -> Conversation
create_child(parent_id, relation, input, operation_id) -> Conversation
submit(conversation_id, input, operation_id) -> InputReceipt
steer(conversation_id, expected_turn_id, input, operation_id) -> SteeringReceipt
cancel(conversation_id, expected_turn_id, operation_id) -> TurnSnapshot
watch(conversation_id, after_sequence, condition) -> WatchResult
```

- `fork` 同样通过 `ApplicationCore` 与 `operation_id` 暴露，接受可选 `at_turn_id` 并保持独立历史副本语义（[ADR-0005](0005-session-fork-copies-events.md)）。
- `submit` 是普通输入的唯一入口：始终先持久化为排队输入，会话空闲时由单消费者调度器立即认领并创建 Turn，已有在途 Turn 时保持排队；调用方无需先查状态再分支提交，消除状态检查与提交间的竞态。
- `steer` 仅用于向指定在途 Turn 追加即时纠偏，必须携带 `expected_turn_id`，不创建新 Turn，也不进入普通队列。

### 2. 持久排队输入与延时输入

- **事件溯源队列**：每条排队输入拥有稳定 `input_id`、`operation_id`、`revision`、创建者、结构化 `PromptBlocks`、Agent/配置选择与排序键，状态按 `Queued -> Claimed -> Dispatched(turn_id)`（含 `Updated`、`Cancelled`，以及仅在未建 Turn 且 claim 过期时回退 `Queued`）记录于 SQLite 事件日志。
- **单消费者与幂等**：同一 Conversation 仅有一个输入消费者；claim、事件追加与队列投影更新在同一 SQLite 事务内完成；调度器先创建 Turn 并持久化 `Dispatched(turn_id)` 再向 Agent 发送 Prompt，发送后崩溃按 [ADR-0001](0001-crash-recovery-semantics.md) 转为 `Interrupted` 且绝不重新入队。`operation_id` 在同一 principal、command 与资源范围内幂等，payload 冲突直接失败。
- **可编辑性与草稿边界**：`Queued` 状态支持多条编辑、取消与重排；进入 `Claimed`/`Dispatched` 后不可修改。Composer 未提交内容仍为服务端共享草稿（[ADR-0042](0042-conversations-are-first-class-dockview-panels.md)），仅在被服务端接受后才成为排队输入。
- **延时输入（Delayed Input）**：延时输入作为独立持久事实存在，到期前不占据普通队列顺序；到期后由 `ApplicationCore` 提升器使用该行自身的 `operation_id` 调用 `submit` 进入普通队列（省略或 0 延迟则立即 `submit`）。

### 3. 能力诚实的 Turn Steering

- `SteerActiveTurn` 属于协议无关的 Agent 运行时接口，由当前连接的原生引擎或 ACP 握手真实能力驱动；控制面永不把失败的 `steer` 静默降级为排队输入（不支持返回 `steering_unsupported`，目标变化返回 `turn_conflict`）。
- Host 为每个会话合成 `delivery_channel`（`none | native | pull`）：`native` 当且仅当当前原生引擎支持或本次握手广告 `_meta.steering.supported`；`pull` 当且仅当本会话实际注入了 `check_user_feedback`。通道无法承载完整草稿（如文件、插件引用或 `pull` 通道下的图片）时，由 Composer 显式走 `submit`。
- Steering 请求、Agent receipt 与拒绝均进入事件日志；receipt 前断连记录未知/中断证据，不自动重发。`pull` 通道的未读备注持久化于 `conversation_feedback_note`，Turn 空闲时由 pending 变为 expired，salvage/dismiss 恰好执行一次；若实际触发了 `StartedNewTurn`，通道锁存为 `none`（无 pull 工具时）或 `pull`，不当作运行中插入成功。

### 4. `ConversationRelation` 统一拓扑与委派/协作边界

- 父子关系使用统一实体 `ConversationRelation { parent_conversation_id, child_conversation_id, kind: fork | delegation | workflow_step | spawned, visibility: visible | hidden }`，与子会话身份原子创建，统一承担导航、可见性、权限校验与父级摘要聚合，但绝不参与事件历史读取。`spawned` 仅用于导航，不触发委派级联取消。
- Delegation Broker 复用 `ConversationControl` 执行子任务，并快照每次委派策略：one-shot 完成语义、父连接作用域或持久生命周期、工作区策略（`read_only_shared` / `write_serialized` / `write_isolated`，未知写任务默认 `write_serialized`，禁止两个潜在写子任务并发共享工作区，隔离写不自动合并）、硬性上限（depth、max active children、max calls、deadline、max result bytes）以及仅在 Agent 提供可信 usage 时生效的用量限制。
- 协同写权限在 MCP / token 边界按策略执行，不在插件 ID 上分支：会话增强 token 限于祖先/子孙树；协作空间 token 限于同一工作区（自己、子孙、兄弟），其它工作区、已删除或已归档会话表现为不存在且不泄漏标题。协作空间群聊扇出对每个目标收件人座位各执行一次 `submit`。

### 5. 统一命令与事件表面

所有会话写操作与查询通过 `HostCommandRegistry`（[ADR-0078](0078-host-command-registry-single-seam.md)）和版本化 Remote Protocol v1（[ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)）暴露；CLI 使用单一命名集 `conversation create|child|send|steer|wait|cancel|fork`，事件订阅统一以持久化 sequence/cursor 驱动并容忍未知事件。

## Considered Options

- **提供 `auto` / `start` / `queue-if-active` / `steer-if-active` 多种发送模式**：否决。迫使调用方感知内部状态机并在检查与提交间引入竞态。
- **Steering 不支持时自动降级为排队输入**：否决。运行中纠偏与下一回合输入的时机和意图不同，静默降级会误导用户。
- **引入专用 Manager Conversation 类型**：否决。普通 Conversation 配合 `ConversationRelation` 与父级聚合投影已完整覆盖协调需求。

## Consequences

- 排队、幂等、延时提升、纠偏与父子关系逻辑完全收敛在 Host 后端，多端视图天然一致且跨刷新/重启可恢复。
- 前端与远程客户端不再维护独立本地发送队列，统一消费服务端事件与投影。
