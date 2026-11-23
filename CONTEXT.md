# Dimo — Ubiquitous Language

Glossary of domain terms across Dimo. Entries stay implementation-free and express current domain truth; permanent design decisions live in [`docs/adr/`](docs/adr/).

---

## Conversation Domain

- **Conversation（会话）** — 用户与 Agent 交互的持久对话；可顺序更换 Agent 绑定，同一时刻至多一个 Turn 在途。历史事件与时间线投影以 SQLite 为唯一权威，与 Agent 进程存活无关。见 [ADR-0089](docs/adr/0089-conversation-binding-generations-and-history-segments.md) 与 [ADR-0091](docs/adr/0091-sqlite-single-authority-conversation-projection.md)。
- **Conversation panel（会话面板）** — 在 Server-bound window 中呈现一个 Conversation 的唯一 Dockview 视图；同一窗口重复打开只聚焦已有面板，关闭或移动面板只改变布局，不取消在途 Turn，也不删除 Conversation。见 [ADR-0042](docs/adr/0042-conversations-are-first-class-dockview-panels.md)。
- **Conversation draft（会话草稿）** — 属于 Host 上某个 Conversation、可由已授权设备继续编辑的未提交 Composer 内容；按 revision 保存，冲突时同时保留服务端版本与本机版本，绝不静默覆盖。
- **Session auxiliary capability（会话辅助能力）** — Composer 与时间线周围的用量、计划、目标、压缩、草稿与查找只呈现 Agent 或用户明确给出的事实；缺失保持缺失，不从自由文本反推，也不把未知填成零或成功。见 [ADR-0058](docs/adr/0058-session-auxiliary-capability-honesty.md)。
- **Conversation input（会话输入）** — 已被 Host 接受、等待产生新 Turn 的持久用户意图；区别于未提交的 Conversation draft 和向在途 Turn 追加的 Steering。见 [ADR-0044](docs/adr/0044-conversation-control-plane-and-durable-inputs.md)。
- **Queued conversation input（排队会话输入）** — 尚未认领并绑定到 Turn 的 Conversation input；同一 Conversation 的排队输入顺序稳定，所有已授权设备一致可见并可编辑。
- **Delayed input（延时输入）** — 尚未进入普通队列的定时输入，到期后提升为排队输入。
- **Turn steering（回合纠偏）** — 针对指定在途 Turn 追加的即时指导；归属于该 Turn，不创建新 Turn，且在 Agent 不支持时不会静默降级为排队输入。
- **Turn（回合）** — 会话内一次「用户发起 → Agent 应答完毕」的完整周期，同一会话同一时刻至多一个 Turn 在途。
- **In-flight turn（在途回合）** — 已开始、尚未到达终态的 Turn。
- **Turn 终态** — 每个 Turn 最终恰好落入四者之一：
  - **Completed（完成）** — Agent 正常应答完毕。
  - **Failed（失败）** — Agent 侧报告了错误。
  - **Cancelled（取消）** — 用户主动请求停止。
  - **Interrupted（中断）** — 宿主进程在 Turn 运行期间崩溃、强杀或重启导致生成中断。中断的 Turn 只能由用户手动重试，绝不自动重发。见 [ADR-0001](docs/adr/0001-crash-recovery-semantics.md)。
- **Session resume（会话恢复）** — 将既有会话上下文重载进新拉起的 Agent 进程；恢复的是上下文，绝不是在途 Turn 的生成过程。
- **Agent binding（Agent 绑定代次）** — Conversation 与某次 Agent 原生会话的持久关联；按 `continuation_key` 追踪可恢复的 resume head，切换或重绑定不破坏历史归属。见 [ADR-0089](docs/adr/0089-conversation-binding-generations-and-history-segments.md)。
- **Conversation history segment（会话历史片段）** — Conversation 历史中具有明确顺序与来源的一段内容；多段历史共同构成用户看见的完整会话，不随当前绑定 Agent 改变。
- **Deterministic handoff（确定性交接）** — 跨 Agent 切换或恢复时，由宿主基于 SQLite 已持久化历史按字节预算确定性组装交接上下文（零隐式 LLM 调用），经持久状态机（`planned → sending → delivered | uncertain | cancelled`）投递确认。见 [`docs/specs/cross-agent-continuation.md`](docs/specs/cross-agent-continuation.md)。
- **Session rebind（会话重绑定）** — 旧 Agent session 无法继续加载时，经用户确认后为既有 Conversation 建立新的冷启动 Agent session；Dimo 历史保持不变，后续交接内容由用户控制。
- **Session fork（会话分叉）** — 从已完成 assistant 消息所属 Turn（或会话尾部）非破坏性地复制分叉点及之前历史，创建独立演化的新 Conversation。见 [ADR-0005](docs/adr/0005-session-fork-copies-events.md)。
- **Recovery（启动恢复）** — 宿主启动时对上一次进程遗留状态的协调：将孤立的在途 Turn 判定为 Interrupted，将未确认的 `sending` handoff 置为 `uncertain`，使会话回到可发起新 Turn 的状态。
- **Event log & Timeline projection（事件日志与时间线投影）** — SQLite 中的 `conversation_events`（经流式合并落盘）与行级增量维护的 `conversation_timeline_rows` 共同构成会话权威；前端只消费带单调 `revision` 的 `TimelineRow`。见 [ADR-0091](docs/adr/0091-sqlite-single-authority-conversation-projection.md)。
- **Conversation relation（会话关系）** — 两个独立 Conversation 之间用于导航、可见性和汇总的亲子关系；各自历史与事件流完全独立。
- **Delegated conversation（委派会话）** — 父 Conversation 为明确子任务创建的一次性 child Conversation；子 Turn 到达终态即结束，父级退出会取消运行中的委派。见 [ADR-0031](docs/adr/0031-llm-mediated-delegation-and-ampersand-agent-mentions.md)。
- **Spawned conversation（派生会话）** — 通过 `create_conversation` 创建的一等 peer Conversation；与父会话仅有导航关系，不级联取消。
- **Same-workspace send（同工作区发送）** — 协同写路径可向同一工作区内的自己、子孙或其他会话提交输入；跨工作区、已删除或已归档的会话表现为不存在。
- **Workspace-less conversation（无工作区会话）** — 不挂靠任何 Project / Workspace 的纯对话会话，使用宿主分配的专用低权限临时目录，其余生命周期与常规会话一致。见 [ADR-0006](docs/adr/0006-workspace-less-conversation.md)。
- **Project-root workspace（项目根工作区）** — 绑定项目仓库目录本身、当前检出分支的 Workspace（`use_worktree: false`），是从首页打开项目时的默认工作区。见 [ADR-0068](docs/adr/0068-workspace-default-surfaces-and-activity.md)。
- **Agent long-running terminal（Agent 长期终端）** — Agent 拉起并持续到命令结束的终端进程投影（如 `Codex-01`），区别于用户 PTY 与 `ExecutionProcess`。见 [ADR-0068](docs/adr/0068-workspace-default-surfaces-and-activity.md)。
- **Workspace activity（工作区活动）** — 右侧栏执行进程入口呈现的统一活动列表：Agent 会话进程、后台长期任务、错误与警告。
- **Composer reference（Composer 引用）** — 在 Composer 中通过 `@` 打开的带 Tab 结构化引用面板（文件、项目、会话、提交、指令）；`/`、`$`、`&` 为独立触发符。见 [ADR-0065](docs/adr/0065-composer-at-reference-panel.md)。
  - **Project reference（项目引用）** — 点名 Dimo 中的 Project，发送时展开为绝对路径。
  - **Quote reference（引用片段）** — 从消息流选中的引用片段，序列化为 `[:quote](context)`。
  - **Conversation reference（会话引用）** — 点名另一段 Conversation，序列化为 `[title](dimo://conversation/<uuid>)`，Agent 通过 `get_session_info` 只读查阅。
  - **Commit reference（提交引用）** — 点名仓库一次 git commit，序列化为 `[shortSha](dimo://commit/<repoId>@<sha>)`。
  - **Instruction reference（指令引用）** — `@` 指令 Tab 插入的标签与内置指令。
- **Agent mention（Agent 提及）** — Composer 中用 `&` 插入的结构化引用，提示父 Agent 考虑将任务委派给指定 Agent。仅当协作空间已启用且当前会话具备委派条件时可用。见 [ADR-0031](docs/adr/0031-llm-mediated-delegation-and-ampersand-agent-mentions.md) 与 [ADR-0065](docs/adr/0065-composer-at-reference-panel.md)。

---

## Collaboration Space Domain

协作空间是内置的宿主能力（`设置 → 通用 → 协作空间`，默认开启），权威定义见 [`docs/architecture.md#collaboration-member-identity`](docs/architecture.md#collaboration-member-identity)。

| 代码标识 | 开发术语 | 界面文案（中文 / English） |
| --- | --- | --- |
| `member`（`member.*`、`member_id`、`collaboration_members`） | bot | 助手 / Bot |
| `space` / group thread（`space.*`、`kind: group`） | 群组 | 群组 / Group |
| direct thread（`direct:<member_id>`、`kind: dm`） | 私聊 | 私聊 / DM |
| group thread 内的消息 | 群聊 | 群聊 / Group Chat |

_Avoid_: MultiAgent协同, 多智能体协同插件

- **Role（角色）** — 设置中可复用的会话模板（名称、可选团队、简介、人设、Agent 与默认配置），用于新建一等会话或种子化新建 bot。
- **Team（团队）** — 角色在设置中的可选分组，区别于联系人列表的 Contact group。
- **Bot（代码中为 member）** — 协作空间中的长期协作身份，名下拥有一族隐藏会话（一条私聊 + 每个群组各一条）；UI 只展示 bot 与聊天，不暴露底层会话 ID。
- **Direct thread（私聊）** — 与 bot 一对一聊天的会话（`direct:<member_id>`），随 bot 创建而建立。
- **Group space（群组）** — 多 bot 与用户共处的协作房间，拥有共享房间日志 `space_messages`。
- **Contact group（联系人分组）** — 联系人列表中私聊与群组的归档分组；无分组时平铺，「未分组」仅由前端生成。
- **Conversation persona（会话人格投影）** — 创建会话时从角色或 bot 抄录的快照（名称、团队、简介、Agent），后续修改角色或 bot 配置不改写既有会话。
- **Persona notice（人设说明）** — 创建会话时写入时间线的首条可见说明。
- **Space member seat（空间座位）** — 群组中绑定的一个 bot 座位及其隐藏会话；用户座位对 Agent 不可见。
- **Space message（空间消息）** — 群组房间日志里带单调序号的一条记录。
- **Delivery receipt（投递回执）** — 一条空间消息向单个 bot 座位的提交状态：`queued → processing → {replied | passed | timed_out | cancelled}`，读取时派生 `failed` 与 `limit_reached`。

---

## Channel Domain

- **Chat channel（聊天通道）** — 宿主与外部 IM（Telegram、飞书、企业微信、微信 iLink、QQ、Webhook）之间的双向桥接：向外推送事件通知，向内接收授权发送者的远程命令与审批，走当前 Host 同一接缝。见 [ADR-0056](docs/adr/0056-chat-channel-and-remote-access-codeg-parity.md) 与 [ADR-0062](docs/adr/0062-chat-channel-host-closed-loop.md)。
- **Telegram topic mode（Telegram 主题模式）** — 论坛超群中一题一会话；总题忽略纯文本，总题上的 `task` 创建新主题并绑定会话。
- **Weixin iLink（微信 iLink 机器人）** — 扫码接入的双向微信机器人；企业微信群机器人仅出站，二者通过 `config.mode` 区分。
- **Authorized sender（授权发送者）** — 聊天通道配置中明确允许下发入站命令的身份；既无绑定目标也无授权列表时入站整体禁用（fail-closed）。
- **Remote approval / Remote question answer（远程审批 / 远程提问答复）** — 授权发送者经聊天通道对宿主待决权限请求或提问作出的响应，与桌面端互斥消解同一事件记录。

---

## Pulse, Automation & Workflow Domain

### Pulse Event Engine（见 [ADR-0092](docs/adr/0092-pulse-event-driven-automation-and-dual-primitive-workflows.md) 与 [`docs/specs/pulse-automation-engine.md`](docs/specs/pulse-automation-engine.md)）

- **Pulse（脉冲事件引擎）** — Dimo 的统一事件驱动自动化引擎，将外部 Webhook（GitHub、Jira、飞书）、自定义 SDK 事件、定时/SLA 事件与内部协作事件规范化并经安全护栏路由到受控执行目标。
- **EventEnvelope（规范事件信封）** — Pulse 总线上的统一事件载体，包含 `eventType`、`source`、`trustLevel`、`actor`（含 `isSelf`）、`trace`（`hopCount`、`rootEventId`、`parentEventId`）、`threadKey` 与 `payload`。
- **Pulse target（脉冲路由目标）** — 规则匹配后的五类受控目标：`Session`（隔离临时会话）、`Bot`（持久化协作助手 + `BotTurnMailbox`）、`Group`（多助手群组阶段）、`User`（交互通知/确认门）或 `Workflow`（发布版 DAG 运行）。
- **Mandate provenance（授权溯源护栏）** — 限制不可信外部事件自动创建或激活高权限规则的校验机制；非受信上下文提议的规则保持 `Draft` / `Shadow` 态，需用户确认后生效。
- **TemporalSource（时间事件源）** — 统一承载 Cron 调度、一次性定时器与不活跃 SLA 追踪（`InactivitySlaTracker`）的事件源。

### Automation（见 [ADR-0032](docs/adr/0032-automations-replay-versioned-turn-launch-specs.md) 与 [ADR-0049](docs/adr/0049-workflow-source-artifacts-and-portable-automation-specs.md)）

- **Automation（自动化）** — 版本化的 manual 或 schedule 触发配置，创建时固定目标类型（单次会话 Turn 或指定发布版本 Workflow），生命周期内不可切换。
- **Automation spec（自动化规格）** — 可复制、版本化的无凭据、无机器路径创作配置；导入后需解析当前 Host 引用并保持禁用直到用户确认启用。
- **Automation run（自动化运行）** — Automation 的一次真实触发实例，终态由关联 Turn 或 Workflow run 的持久事实决定。
- **Automation owner（自动化所有者）** — 对同一数据目录唯一持有 Engine lease 的 Host；负责 reconciliation、事务性 **Due claim（到期认领）**、启动恢复（不重触发遗留运行，停机期间至多补跑一次最近错过的 schedule）以及保留清理（默认 30 天 / 10 GiB 配额）。
- **Automation isolation（自动化隔离）** — 默认为每次 Run 创建独立 Git worktree；绝不自动 merge、push、publish 或 deploy。

### Workflow（见 [ADR-0045](docs/adr/0045-workflows-orchestrate-conversation-turns.md)、[ADR-0050](docs/adr/0050-interactive-workflow-debug-runs-and-step-conversations.md)、[ADR-0053](docs/adr/0053-agent-step-native-session-text-handoff-and-confirmation-projections.md) 与 [ADR-0092](docs/adr/0092-pulse-event-driven-automation-and-dual-primitive-workflows.md)）

- **Workflow source artifact（工作流源产物）** — 工作区中可编辑、可入版本控制的 `*.dimo-workflow.json` 源文件。
- **Workflow definition（工作流定义）** — 经 **Workflow publish（发布）** 校验生成的不可变版本化 DAG，声明输入、步骤依赖、输出引用与执行策略。
- **Dual-primitive workflow（双原语工作流）** — 在同一 DAG 中组合临时 `SessionStep`、持久化 `BotStep`（配 `BotMailboxPolicy`）、`GroupStageStep`、`UserGateStep`、`BoundedLoopStep`、`WaitForEventStep`、`OutboxActionStep` 与 `ConditionBranchStep` 的工作流模型，支持 `WorkflowGraphPatch` 增量修改。
- **Workflow run & Derived workflow run（工作流运行与派生运行）** — `WorkflowDefinition` 在指定输入与工作区上的持久执行实例；派生运行从既有运行的指定步骤开始，在满足 **Workflow checkpoint（检查点）** 约束时复用上游证据。
- **Workflow run pause（运行暂停）** — 停止新步骤调度并取消全部在途 Turn，进入可恢复 `paused` 态；不回滚已有副作用，继续对话在原 Child Conversation 创建新 Turn。
- **Agent step / Approval step（Agent 步骤 / 审批步骤）** — Agent 步骤通过持久 Child Conversation 执行一个或多个真实 Turn；审批步骤等待授权主体作出持久决定。
- **Candidate / Accepted step output（候选与已接受步骤输出）** — Agent 步骤已完成 Turn 的最后一条非空 Assistant 原始文本；输出 Schema 仅作 Prompt 示例，按 automatic 或 manual **Completion gate（完成门）** 接受后供下游引用。Studio 为 manual 步骤派生可视 **Confirmation node projection（确认节点投影）**。
- **Debug run & Debug breakpoint（调试运行与断点）** — 只作用于某次调试运行的单步或传递下游执行与临时检查断点，不修改已发布定义。
- **Workflow controller agent（控制 Agent）** — 经用户授权、通过 Workflow MCP 审阅证据、追加输入或接受候选输出的独立主体，与 worker Agent 分离并全程可审计。
- **Needs review（需要复核）** — 系统无法证明自动继续或重试不会重复副作用时的非终态，需用户显式决定推进或结束。

---

## Plugin, Tool & Artifact Domain

见 [ADR-0046](docs/adr/0046-full-stack-plugin-platform-and-isolated-sdk.md)、[ADR-0047](docs/adr/0047-product-centric-plugin-package-and-content-model.md)、[ADR-0048](docs/adr/0048-full-trust-plugin-execution-model.md)、[ADR-0055](docs/adr/0055-official-product-mcp-activation.md)、[ADR-0066](docs/adr/0066-plugin-marketplace-authoring-and-session-honesty.md) 与 [ADR-0069](docs/adr/0069-everything-is-a-plugin-platform.md)。

- **Plugin control plane（插件控制面）** — Dimo Plugin Package 的唯一安装、启停、更新、诊断、回滚与卸载权威；可投影读取 Agent-native plugin 但不夺取 Agent 原生权威。
- **Dimo Plugin Package（Dimo 插件包）** — 以稳定 **Plugin identity**（`Publisher + Plugin ID`）和安装物身份（`owner/plugin-name/tag/version`）交付完整功能的产品包，包含根 `README.md`（含一句话 `summary` frontmatter）、`contents/`、`depends/` 与 `config.json`（由 manifest schema 校验，不计入包 digest）。
- **Full-trust plugin（全信任插件）** — 用户经安装预览弹窗确认并安装 Dimo Plugin Package 即授予与当前 Host 同等的本机执行信任；独立 Worker 与 iframe 仅提供生命周期、热更新与崩溃隔离，不是安全沙箱。
- **Plugin module（插件模块）** — 「设置 → 插件」中的独立产品入口，顶层包含「已安装」与「插件市场」两个目录 Tab（官方分类默认置顶），详情页包含「内容」与「配置」主 Tab；详情配置区可由插件提供自定义 App surface。
- **Agent plugin setting（Agent 插件设置）** — 「设置 → Agent → 对应 Agent」底部的原生插件上下文，仅呈现该 Agent 自有的 Skill、MCP、Runtime、Hook 与 Workflow。
- **Linked development plugin（链接开发插件）** — 持续跟随本地开发目录的插件链接，源变动触发重新校验，Dimo 永不删除开发目录。
- **Contribution point & Takeover surface table（贡献点与接管面总表）** — 宿主声明并文档化的稳定扩展位（UI slot、内容类型、Provider 缝或 `host.call` API 面）；所有新增宿主能力先登记接管面总表并与首个官方插件同批验收。
- **Provider seam（Provider 缝）** — 宿主能力的可替换提供者接缝（内置默认与插件贡献同权）；冲突按确定规则聚合或由用户显式单选。
- **Triple rendering tracks（渲染三轨）** — 宿主渲染 descriptor（`L1`）、Module Federation 面板（`protocol: "2.0"`，高频交互结构面）与 iframe App surface（`protocol: "1.0"`，文档/富媒体 UI）。
- **Dual activation semantics（生效双轨）** — UI 与 Provider 贡献启用即生效、禁用即原子撤下；Agent 侧贡献（Skill、MCP、Hook）在新建或重绑定会话后生效。
- **Capability-parity plugin（能力等价插件）** — 按 Host 版本固化白名单自动安装并默认启用的官方插件，用户可自由禁用或卸载。
- **Derived plugin（派生插件）** — 复制并修改源码、以新 Publisher + Plugin ID 打包的独立插件（携带 `derivedFrom` 溯源），不继承原插件数据或配置。
- **Single-layer extension（单层扩展）** — 插件只面向宿主贡献点开发，不存在插件依赖插件或跨插件扩展点。
- **Activation Generation（激活代）** — 插件包、Runtime locks 与全部就绪贡献原子发布的不可变运行快照；更新失败保留上一完整激活代。
- **Plugin Worker & App surface（插件工作进程与应用扩展面）** — Host 上托管的 Node / Python / Rust 后端进程与前端渲染实例；通过 `host.call`（含插件会话能力与独立 scratch 工作区）操作授权范围资源。
- **Host-managed Plugin MCP & Official product MCP（宿主托管插件 MCP 与官方产品 MCP）** — 由 Host 解析 Runtime 并按 Agent 会话注入连接上下文的本地 MCP Server（`dimo.session-enhance`、`dimo.workflow-creator` 由对应官方插件激活；协作空间与 Pulse 工具由宿主内置能力激活）。
- **Agent binding & All-agents binding intent（Agent 绑定）** — 控制已激活插件的 Agent 贡献暴露给哪些 Agent 或 Project；默认覆盖所有兼容已启用 Agent 并记录显式排除项。
- **Skill projection（Skill 投影）** — 将插件 Skill 只读投影到 Agent 原生 Skill 目录，不覆盖用户同名 Skill。
- **Plugin Command / Agent Command / Command candidate** — Composer 命令候选携带结构化来源身份，同名项并存不静默覆盖。
- **Runtime requirement / Installation lock / Probe / Inventory** — 插件依赖的 CLI / Binary / MCP 资源以声明、精确锁（版本、平台、哈希、所有权）、有界健康探测和引用计数独立建模；**Global command export** 需用户显式开启。
- **Agent-native plugin（Agent 原生插件）** — 由 Codex、Claude Code 等 Agent 原生存储与信任体系管理的插件，经 **Native plugin reconciliation** 如实投影到 Dimo。
- **Artifact & Artifact preview lease（产物与预览租约）** — 文件系统中文件的持久身份（数据库仅存相对路径、哈希与来源证据）及引用计数预览租约。

---

## Remote & Device Domain

见 [ADR-0033](docs/adr/0033-shared-application-core-and-versioned-remote-transport.md)、[ADR-0054](docs/adr/0054-host-family-distribution-and-client-surfaces.md)、[ADR-0059](docs/adr/0059-host-identity-and-pairing-invitation.md)、[ADR-0070](docs/adr/0070-ssh-provisioned-remote-server.md)、[ADR-0078](docs/adr/0078-host-command-registry-single-seam.md) 与 [ADR-0090](docs/adr/0090-electron-thin-shell-and-desktop-sidecar.md)。

- **Application Core（应用核心）** — 不依赖具体传输层或桌面壳的用例门面；Electron 桌面端、浏览器 WebUI、远程工作站与移动端经统一接缝调用。
- **Host Command Registry & Host Event Bus（命令注册表与事件总线）** — Host 上唯一的产品命令集合与事件推送面，`/api/v1/capabilities` 由注册表自动派生；原生桌面壳辅助操作通过 `DesktopShellBridge` 保持在产品命令表之外。
- **Dimo Host & Host family（Dimo 主机与 Host 家族）** — 独占一个 Dimo SQLite 数据目录并提供 Remote Protocol v1 的运行实例（`dimo-server`，既可作为 Electron 桌面 sidecar 运行也可作为无头守护进程运行）；同一产品版本发布 Desktop、`dimo-server` 与 Companion 安装包。
- **Host identity（Host 身份）** — 数据目录在配对与 capabilities 中出示的稳定身份，客户端按 Host 身份合并 Server Profile，不以 URL 识别 Host。
- **Host console（本机控制台）** — 运行 Host 的本机管理面（监听、Reachability 发布、配对邀请、设备撤销、管理员 token 与升级），远程 Workstation 不复制该面。
- **Server profile & Host provision kind（服务器档案与供给类型）** — 客户端对单个 Dimo Host 的本地档案（含 `manual` / `discovered` / `ssh` 供给标记与多条 Reachability），访问凭据独立受保护；由匹配的 **Remote provisioner**（`provider.remote.provisioner`）恢复可达性。
- **Reachability（可达目标）** — 客户端访问同一 Host 的一条 origin（局域网、SSH、FRP、Tailscale、Cloudflare 或 E2EE WebRTC）；通过验证的发布进入权威名单。
_Avoid_: 连接, 隧道, 服务器地址（单独拿来当 Host 身份）
- **Server-bound window（服务器绑定窗口）** — 仅呈现并操作单个 Server Profile 资源的应用窗口，不同 Host 之间绝不混用上下文。
- **Remote disconnect vs Forget server（远程断开与忘记服务器）** — 断开仅结束当前网络连接；忘记服务器删除本地档案、只读缓存与凭据，并在可达时撤销设备。
- **Remote protocol & Durable attach（远程协议与持久附着）** — 版本化 DTO 与 OpenAPI/JSON Schema（位于 [`docs/protocol/v1/`](docs/protocol/v1/)），订阅遵循 `ready → snapshot/replay → high-water → live` 的单调 sequence 契约。
- **Pairing invitation / Paired device / Device permission preset / Device revocation** — 本机控制台生成短时一次性邀请，兑换长期可撤销的 device credential（长期凭据不进 URL 或日志）；权限预设分为 **Workstation Device**（桌面全编码闭环）与 **Companion Device**（移动端薄客户端：会话、审批、只读产物与离线缓存）。
- **Mobile companion（移动伴随端）** — 原生 iOS（[ADR-0084](docs/adr/0084-native-swiftui-ios-companion.md)）与 Android（[ADR-0041](docs/adr/0041-native-kotlin-compose-android-companion.md)）薄客户端，支持只读 **Offline conversation cache**（`read_only: true`）与无敏感信息的 **Terminal notification summary**。

---

## Agent Domain

见 [ADR-0010](docs/adr/0010-agent-runtime-topology.md)、[ADR-0022](docs/adr/0022-agent-native-configuration-is-authoritative.md)、[ADR-0036](docs/adr/0036-user-declared-acp-agents-use-locked-distributions.md)、[ADR-0060](docs/adr/0060-agent-installs-use-user-environment.md)、[ADR-0063](docs/adr/0063-model-provider-presets-not-cc-switch.md)、[ADR-0064](docs/adr/0064-unified-agent-authentication-modes.md)、[ADR-0079](docs/adr/0079-provider-catalog-templates-are-not-import-sources.md)、[ADR-0085](docs/adr/0085-modelrouter-is-a-webview-side-provider-source.md)、[ADR-0087](docs/adr/0087-dedicated-agent-engine-first-acp-fallback.md) 与 [ADR-0088](docs/adr/0088-built-in-provider-presets.md)。

- **Dedicated agent engine（独立 Agent 引擎适配）** — 基于目标 Agent 官方原生 SDK、原生服务协议（如 `app-server`）与原生会话/状态机制直接构建的一等引擎适配，是 Dimo 接入与深化 Agent 能力的首选通道，完整保留精确用量、缓存周期、限流恢复、在途纠偏、协同回退与子代理流。
_Avoid_: ACP 优先, 统一走 ACP 包装器, ACP-only
- **ACP compatibility channel（ACP 次选兼容通道）** — 基于 Agent Client Protocol（ACP v1 基线 + v2 协商能力，见 [ADR-0035](docs/adr/0035-acp-v2-dual-protocol-session-items.md) 与官方索引 [agentclientprotocol.com/llms.txt](https://agentclientprotocol.com/llms.txt)）的通用接入通道，服务于未提供独立引擎的内置 Agent、ACP 官方 Registry 条目与用户声明分发；按运行结构分为 **Native ACP agent** 与 **Adapter-backed ACP agent**。
- **Agent kind & Agent profile（Agent 身份与档案）** — 全系统唯一稳定身份标识与声明式接入契约（描述引擎适配模式、分发方式、检测候选、原生配置与白名单管理动作）。
- **Agent source（Agent 来源）** — 三类受控来源：Dimo Built-in Agent Profile、ACP 官方 Registry、以及 **User-declared agent definition**（仅允许 Binary / npx / uvx 的 Registry-compatible 分发契约，可从 **Community ACP preset** 模板填充）。
- **Built-in agent（内置 Agent）** — Dimo 预置的 20 个永久成员 Agent：Claude Code、Codex、Pi、OpenCode、Grok、Cursor、DeepSeek Harness、Google Antigravity、Cline、OpenClaw、Hermes、CodeBuddy、Kimi Code、Qoder、Kiro CLI、Auggie、TRAE CLI、Command Code、ZCode 与 OMP。
- **Native management priority（原生管理与状态优先）** — 状态探测、配额、模型目录与会话管理能力优先由独立 Agent 引擎与原生本地机制提供，通用 ACP 状态通告作为次选补充；持久配置权威始终在 **Agent-native configuration**。
- **Agent authentication mode（Agent 鉴权模式）** — 每款 Agent 按档案声明支持 **Official subscription（官方订阅）**、**Official API（官方 API）** 或 **Model Provider preset（模型供应商预设）** 的子集；官方订阅与供应商互斥。凭据留在 Agent 原生配置或 Rust 后端，前端不回显密钥。
- **Inline device authentication（页内设备认证）** — 面向固定官方端点的页内设备授权状态机，短期设备码经 IPC 展示，访问令牌由 Rust 后端直接写入官方凭据文件。
- **Model Provider preset（模型供应商预设）** — Dimo 保存的本地可复用连接意图（名称、端点、模型映射与凭据）；同一 Agent 至多启用绑定一个预设并投影至原生配置。内置官方预置目录由 Host 提供，插件可追加无密钥的 **Provider catalog template**（点选只填草稿，保存前不是预设）。
_Avoid_: 统一供应商, 全量配置快照, 本地代理供应商
- **Native Model Provider（原生供应商）** — 仅存在于 Agent 原生配置中的连接；可测连与复制，收编为预设需经 **External provider import**（支持从原生配置或 CC Switch 单次导入，不与 CC Switch 同步）。
_Avoid_: 与 CC Switch 同步, 接管 CC Switch, 直接覆盖当前绑定
- **ModelRouter** — 产品站点运营的模型网关；桌面端经网页层登录选型后写入普通 Model Provider preset，Host 不认识 Dimo 账号。
- **Provider connection probe（供应商连接探测）** — 后端使用已存凭据向端点发起模型目录探测，返回成败与耗时。
- **Agent launch preference & New-session default（启动偏好与新会话默认偏好）** — 由 Built-in Profile 受控投影的 CLI 参数偏好，以及 Dimo 全局记忆的新会话默认选项（不影响既有会话）。
- **User-environment agent installation & Installation lock（用户环境安装与安装锁）** — Agent 运行时统一安装在用户自身环境（PATH、npm 全局前缀、`uv tool`、用户 bin），Installation lock 记录精确路径、版本与分发方式；二进制完整性区分 **Verified binary**（预期 SHA-256）与 **TOFU binary**（首次信任指纹）。
- **Agent readiness states** — **Installed**（组件就绪，与认证分离）、**Ready**（可新建会话）、**Needs-auth**（待认证）、**Management-degraded**（可选管理探测降级）、**Platform-unsupported**（当前系统/架构无可用分发）。
- **Membership & Lifecycle** — **Added agent**（已纳入 Agent 导航带，内置 Agent 永久保留）、**Available agent**（ACP Registry 视图中可添加条目，离线时只读浏览 **Registry snapshot**）、**Agent activation**（独立启用开关）、**Uninstall agent**（卸载 CLI 与清除锁，保留纳入与历史）、**Remove agent**（非内置 Agent 卸载并移出导航带，保留历史）、**Retired agent**（停止新会话但保留历史身份）、**History import**（接管外部本地会话历史）。
