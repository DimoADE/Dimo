---
status: accepted
date: 2026-07-30
decision-makers: Dimo maintainers
---

# Agent 管理与 ACP Registry 以可验证证据为权威并接入 `auth/status`

Dimo 的 Agent 管理体系围绕**可验证持久证据**构建：具备独立原生引擎驱动的内置 Agent 优先走原生引擎与原生状态探测（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)），走次选 ACP 兼容通道的 Agent（含官方 ACP Registry 与用户声明定义，[ADR-0036](0036-user-declared-acp-agents-use-locked-distributions.md)）严格遵循本决策的安装冻结、启动完整性门禁、协商能力快照与 `auth/status` 兼容边界，并依托用户本机环境解析与安装（[ADR-0060](0060-agent-installs-use-user-environment.md)）。

## Decision

### 1. 核心原则与权威记录

管理系统以一组明确分工的持久记录作为唯一事实源，前端与传输层不得绕过它们自行推导状态：

| Record | Authoritative facts |
| --- | --- |
| `RegistrySnapshot` | 已校验官方目录、schema、抓取时间、内容摘要 |
| `FrozenInstallPlan` | 用户确认的 snapshot、Agent、版本、分发、平台、解析制品与资源声明 |
| `InstallationAttempt` | 操作状态、阶段、宿主实例 ID、资源租约与终态 |
| `InstallationLock` | 当前安装精确组件、来源、路径、版本、内容哈希与信任等级 |
| `ComponentVerification` | 某次检查时磁盘内容与 lock 的一致性证据 |
| `AcpCapabilitySnapshot` | 某次 `initialize` 的完整协商能力、协议版本与 fingerprint |
| `AuthenticationObservation` | 带来源、方法分类与时间戳的认证观察 |
| `AgentSessionDefault` | 用户为新会话保存的原始 ACP option ID/value 偏好 |
| `AgentManagementSnapshot` | 上述事实经单一纯 reducer 折叠出的只读投影 |

### 2. 不可变安装计划、持久状态机与资源调度

- **冻结目标**：添加、更新或切换分发方式时提交不可变目标引用，并在入队事务中持久化 `FrozenInstallPlan`；执行器仅消费该冻结计划，不再重新读取可变 Registry。官方 Registry 的安装与更新要求 snapshot 处于 fresh 状态；离线或上游下架时，`repair` 仅依据当前 `InstallationLock` 重建，不依赖上游在线。“检查更新”始终只读，确认后才生成更新计划。
- **持久操作状态机**：安装操作遵循 `Queued -> Running -> Succeeded | Failed | Cancelled | Interrupted`。`Running` 记录宿主 `instance_id` 与心跳；取消令牌仅是当前实例执行工具而非操作存在性权威。宿主启动时将遗留旧实例的 `Queued`/`Running` 操作原子转为 `Interrupted`、释放资源租约并清理未提交暂存目录，绝不自动重跑。
- **资源感知原子调度**：全局最多 2 个并发 mutating operation；同一 Agent 串行；共享包缓存与目标目录通过数据库事务内原子占槽和资源锁互斥；只读 probe 不占全局名额，但与同一 Agent 的切换和卸载互斥。

### 3. 启动门禁（`LaunchGate`）与统一状态投影

- **启动前完整性验证**：每次建立 ACP 连接必须经过 `LaunchGate`——校验 membership、enabled、平台支持、readiness、可执行文件绝对路径以及 `InstallationLock` 中各可执行组件的 SHA-256（`(canonical_path, size, mtime, file_identity, sha256)` 仅作缓存优化，元数据变化或显式检查必须重算）。哈希不匹配时阻断启动并置为 `needs-repair`，不修改或删除用户环境中的外部文件。
- **单一管理投影 Reducer**：`reduce_management_snapshot` 是生成 `AgentManagementSnapshot` 的唯一入口，按严格优先级折叠：`retired/platform_unsupported` → `active_operation` → `no_valid_lock` → `component/hash/handshake_failed` → `missing_required_auth_or_config` → `installed_and_ready`；`enabled` 保持正交，`installed` 只能由有效锁与兼容性验证得出。
- **活动进程定义**：仅 `Starting`/`Ready`/`Busy` 真实连接、在途 Turn 或当前实例活动 mutating operation 可阻止卸载或移除；已断开连接、失败/中断操作与历史 probe 记录不计为活动进程。
- **Registry 投影**：Registry 视图仅展示当前官方 snapshot 条目；已添加但上游下架的 Agent 保留本地 membership 与锁定安装但从 Registry 列表消失；离线/过期快照允许浏览并展示抓取时间，同时禁用新增与更新。

### 4. 事务化原生配置与会话默认偏好

- **原生配置 Prepare / Commit**：保存前重新读取相关文件并执行三方比较（打开时值、磁盘当前值、用户值）；无冲突字段合并并保留未知键，同字段冲突返回结构化 conflict 由用户显式选择重载、采用外部值或覆盖；多文件写入经同目录临时文件校验后以可回滚原子 rename 提交，并刷新认证与能力目录 fingerprint。
- **会话默认偏好（`AgentSessionDefaultRepository`）**：按稳定 `AgentId` 存储原始 option ID/value，仅当新会话或 rebind 会话仍广告完全匹配的选项时应用；失效项回退 Agent 默认并提示而不阻塞就绪。

### 5. 协商能力真相、有界探测与 `auth/status` 兼容层

- **完整能力快照与目录新鲜度**：完整保存 `initialize` 协议版本、agent info 与能力集（load、resume、close、fork、list、delete、`additionalDirectories`、prompt 多媒体、terminal/fs/elicitation、config options、MCP stdio/HTTP/SSE、auth logout/`auth/status`、有界 `_meta`），缺省归一为 unsupported，严禁硬编码 `true`。能力目录 fingerprint 由 `AgentId + lock digest + protocol/agent version + capabilities digest + native config revision + auth generation + provider generation` 组成，同 fingerprint 刷新合并去重，旧 generation 不覆盖新 generation。
- **有界 `ProbeScope`**：所有探测在统一作用域内运行，每条退出路径（成功、超时、取消、异常）保证释放临时 session、终止并回收子进程、移出活动集合、删除临时目录并写入脱敏诊断。
- **稳定 ACP 能力边界**：`additionalDirectories` 仅传递当前工作区显式关联的附加根；`session/list` 与 `session/delete` 保持外部会话与 Dimo Conversation 身份独立；`session_info_update` 不覆盖用户显式标题；`_meta` 按命名空间有界存储且绝不绕过能力/权限门禁；usage/cost 作为累计观察展示而非账单权威；HTTP MCP 与音频/嵌入资源/资源链接端到端无损传递。
- **`auth/status` 兼容层**：ACP Draft `auth/status` 协议结构隔离在 `AcpAuthStatusAdapter` 内，向上输出稳定领域模型 `AuthenticationObservation`（`state: authenticated | unauthenticated | unknown | degraded`，`method: api_key | account | unknown`，`source`）。仅当 `agentCapabilities.auth.status == true` 时在 `initialize` 后以短超时调用；错误/超时/method-not-found 降级为 `degraded`/`unknown` 而不判安装损坏；不把单纯 `authenticated: true` 虚构为“账号登录”或“API Key 登录”；ACP 结果与原生配置/本地证据冲突时标为 `degraded`；`authentication_required = false` 的 Agent 不被阻断；未广告 `auth/status` 时禁止用 `session/new` 做后台猜测探测，真实会话返回 `AuthRequired` 再更新观察。

### 6. Application Core 服务边界

Agent 管理收敛在 `ApplicationCore` 的 `AgentManagementApplicationService` 下，按职责拆分为 `RegistryCatalogService`、`InstallPlanService`、`InstallationCoordinator`、`ArtifactIntegrityService`、`ProbeAndCapabilityService`、`AuthenticationObserver`、`NativeConfigTransactionService` 与 `ManagementProjectionService`；传输层仅做 DTO 与错误映射。

## Consequences

- 安装、修复、更新与探测全部可恢复、可审计、可复现，不依赖易失的内存句柄或可变远端快照。
- 草案协议漂移被严格限制在 `AcpAuthStatusAdapter` 与协议 fixture 内，核心领域与 UI 保持长期稳定。
