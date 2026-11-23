---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# Turn 失败分类以结构化证据为准，恢复过程与恢复结果对用户可见

## Context

Turn 失败卡片需要根据失败原因向用户提供有效动作（重试、重新绑定、等待限流重置或查看详情），而会话恢复过程需要明确的中间态与自愈清除信号。本决定将 [ADR-0058](0058-session-auxiliary-capability-honesty.md) 的诚实性原则延伸到错误与恢复路径，与 [ADR-0071](0071-conversation-turn-integrity.md) 与 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md) 协同工作，确立「分类只认结构化证据，永不猜自由文本」的硬边界。

## Decision

### 1. 失败证据三级划分

| 级别 | 来源 | 示例 |
| --- | --- | --- |
| A 协议 / 引擎事实 | 独立 Agent 引擎结构化错误字段（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）、ACP / JSON-RPC 错误码位与 `error.data` 结构化字段 | `-32603`、`data.http_status = 429`、引擎限流重置时间 |
| B 宿主观测 | 宿主发起的请求与托管进程事实 | 子进程异常退出码、连接层 HTTP 状态码、空闲看门狗超时 |
| C 自由文本 | `error.message`、Agent 助手自然语言文本 | `"rate limit exceeded"` |

只有 **A 级与 B 级** 证据允许参与失败分类。**C 级自由文本仅作原样展示，永不参与分类或正则匹配。** 缺乏 A/B 证据时归为 `unknown`，原样展示错误信息并提供重试。

### 2. 结构化失败分类与对应动作

- **`rejected`（请求被拒绝）**：A 级 `-32600 invalid_request`、`-32602 invalid_params` 或引擎协议级请求拒绝。**不提供原样重试按钮**（重发必然再失败），仅提供「查看详情」与「重新绑定会话」。
- **`service_error`（服务故障）**：A 级 `-32603 internal_error` 或 `data` 中 5xx HTTP 状态；B 级 Agent 子进程非正常退出。提供「重试」。
- **`rate_limited`（触发限流）**：A 级引擎结构化限流字段或 `data.http_status = 429`（含可选重置时间）；B 级宿主直连请求收到 HTTP 429。展示重置时间（若有）并允许稍后重试。缺少 A/B 证据时绝不将普通失败猜成限流。
- **`rpc_{n}` 兜底可见**：未映射的协议码位产出 `rpc_{n}`，按 `unknown` 处理并在 UI 中原样展示原始码位，便于复制排查。

### 3. 已缓存配额事实并列展示，不改写分类

当 Turn 失败且宿主已持有该 Agent 的缓存订阅额度事实（`plan_usage` / `provider.usage`）时，失败卡片可将该事实作为旁证并列呈现（「请求失败」与「当前订阅额度窗口已用尽，将于 X 重置」），不得表述为因果关系，也不得在失败瞬间主动发起额外额度探测请求。

### 4. 恢复中间态与恢复成功事件闭环

- **`Recovering` 状态贯通**：`AgentConnectionStatus::Recovering` 绑定到两个真实窗口——会话恢复窗口（`session/load` / `session/resume` 或原生引擎会话恢复期间）与重绑窗口（`BindingStatus::Recovering` 到新会话 Ready 之间），并 1:1 映射为 `ConversationAgentConnectionStatus::Recovering`。
- **恢复成功显式发事件**：`prepare_session` / 恢复路径在存在未清除失败通知或处于 `Recovering` 状态并成功恢复时，准确发出 `AgentBindingRecovered`（`Loaded` / `Resumed` / `CreatedNewSession` / `Rebound`）；投影据此自动清除已失效的加载失败通知。首次正常建连不发恢复事件。

### 5. 失败码位由 Rust 单一定义并导出

所有 Turn 失败码位枚举由 Rust 侧权威定义，经 `pnpm run generate-types` 导出至 `shared/types.ts`，前端通过穷尽类型分支消费，避免前后端手写两份字符串表导致静默落入 `default`。

## Consequences

- `TurnErrorCard` 的操作按钮严格由结构化分类决定，`rejected` 场景消除无效重试。
- 独立引擎适配（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）能够原生提供精确限流与错误字段，提升结构化分类覆盖率；对未提供结构化字段的 ACP Agent，宁可诚实展示 `unknown` + 原始码位，也不引入脆弱的文本正则。
- 会话自愈成功后，时间线中的旧加载失败通知自动清除，避免过时告警长期滞留。

## Considered Options

- **通过正则匹配 `error.message` 判定限流**：否决。违反 [ADR-0058](0058-session-auxiliary-capability-honesty.md)，跨 Agent 与多语言误报会把真实服务故障错报为用户超额。
- **失败时即时触发额度探测反推限流**：否决。在服务异常时追加外部请求，且额度用尽与单次失败之间仅为相关而非因果。
- **将 `internal_error` 混入 `unknown`**：否决。明确区分服务端故障能指导用户直接重试而非修改提示词。
