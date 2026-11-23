---
status: accepted
date: 2026-08-17
decision-makers: Dimo maintainers
---

# 官方产品 MCP 随 Host 分发与分层激活

## Context

`dimo-mcp` 与 `dimo-workflow-mcp` 是随 Dimo Host 家族原生分发的官方产品 MCP 二进制。它们服务于三类独立的产品能力——宿主内置的**协作空间与多智能体委派**、官方插件 **会话增强（`dimo.session-enhance`）**，以及官方插件 **Workflow Creator（`dimo.workflow-creator`）**。宿主必须保证二进制随 Host 零额外安装即可定位，同时确保各产品面的启停、凭据作用域与会话注入边界清晰分离。本决定与 [ADR-0046](0046-full-stack-plugin-platform-and-isolated-sdk.md)、[ADR-0051](0051-host-managed-plugin-scoped-mcp-runtimes.md) 及 [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md) 共同约束官方 MCP 生命周期。

## Decision

### 1. 二进制随 Host 家族原生分发

Host 发行物始终包含官方 MCP 可执行文件，用户无需单独下载或手动拉起进程：

- `dimo-mcp` 位于 Host 可执行文件同目录（支持 sibling 定位与 `DIMO_MCP_BIN` 覆盖）。
- `dimo-workflow-mcp` 作为 `dimo.workflow-creator` 的托管 Runtime（`hostFamilyBinary`），由 Host 直接解析，不依赖用户 `PATH`。

磁盘上存在二进制不等于已注入会话；未开启对应能力或插件时，Host 不得向 Agent 注入该 MCP，设置页也不得显示为已配置。

### 2. 分层激活矩阵（唯一真相源）

| 产品能力 | 激活开关归属 | MCP 载体 | 默认状态与生效条件 |
| --- | --- | --- | --- |
| 协作空间与 `&Agent` 委派 | Host 内置设置「设置 → 常规 → 协作空间」 | `dimo-mcp`（delegation / collaboration 产品面） | **默认开启**；开关打开且 Agent 支持 MCP 注入时生效。主窗口 MCP 状态栏展示同一套宿主 MCP，启停与该设置共享单一事实。 |
| 会话增强（提问、实时反馈、会话查询与控制） | 官方插件 `dimo.session-enhance` | `dimo-mcp`（session-enhance 产品面） | 通过市场安装/启用（可卸载，支持插件内单工具开关）；插件 Enabled、Activation Generation 已发布且 Agent binding 包含该 Agent 时生效。 |
| 工作流开发（`workflow_*` 创作与调试） | 官方插件 `dimo.workflow-creator` | `dimo-workflow-mcp` | 通过市场安装/启用（可卸载）；插件 Enabled、Activation Generation 已发布且 Agent binding 包含该 Agent 时生效。 |

规则约束：

- **协作空间是 L0 宿主能力**：协作投递、隐藏座位会话与工作区表面必须与宿主锁版本，不作为可独立分叉的市场插件。关闭「协作空间」后，新会话不再注入协作工具，新的协作写操作被拒绝，已排队的输入仍正常送达。
- **插件能力独立演进与可卸载**：`dimo.session-enhance` 与 `dimo.workflow-creator` 作为官方市场插件交付，支持按需安装、启用、禁用与卸载。禁用或卸载 `dimo.workflow-creator` 不影响原生 Workflow Studio，也不删除已有工作流源文件、发布版本、Automation 或 Run。
- **仅作用于新会话或重绑会话**：所有官方 MCP 的启停变更仅影响之后新建或重新绑定的 Agent session。已有活跃会话不能热挂载 STDIO MCP，Host 向用户提示重建会话。

### 3. 产品身份与工具目录严格分离

- Workflow 工具留在 `dimo-workflow-mcp`，不得并入 `dimo-mcp`。
- `dimo-mcp` 内部按产品面拆分工具目录与权限 scope（协作空间与会话增强各自独立签发与开关），禁用其中一项不影响另一项。
- Delegation Broker 与 listener 可随 Host 常驻；当协作空间关闭时，Agent 不会收到注入，无法调用相关工具。

### 4. Host 托管凭据与同步门控

- 官方 MCP 由 Host 随 Agent session 启动并注入连接上下文（Workspace、父 Conversation、Plugin generation 及按产品面拆分的最小 scope 凭据）。会话增强等官方插件 MCP 使用插件启用期间受控的长驻最小 scope 凭据，插件禁用或卸载时立即失效。任何插件均不得持久保存 Server URL、管理员 token 或 device credential。
- 注入门控（`DelegationInjector` 与官方 MCP 开关）为进程内同步、非阻塞原子状态，由 Host 设置存储与 Plugin control plane 在启动恢复、导入、启停与切换时实时同步。
- 被关闭或未启用的官方产品 MCP 调用返回稳定失败码 `official_product_mcp_disabled`。

## Consequences

- Host 启动时必须在挂载会话注入器之前完成设置状态与 Plugin control plane 初始化，并同步官方 MCP 门控状态。
- 会话增强与工作流插件均走标准官方市场与全信任安装链路（[ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)），不享有特权或不可卸载特例。
- 协作空间作为内置能力与主窗口 MCP 状态栏保持单一状态来源，彻底消除「平台总是无条件注入 `dimo-mcp`」的隐式行为。

## Considered Options

- **无条件将 `dimo-mcp` 注入所有会话**：否决。用户无法独立关闭协作与委派工具，且违背显式能力控制原则。
- **将协作空间做为可独立发布的市场插件**：否决。协作投递与会话/工作区内部状态必须与宿主锁版本，强行拆缝会产生假想边界。
- **将 `dimo-workflow-mcp` 合并进 `dimo-mcp`**：否决。会把工作流工具目录与生命周期同宿主协作能力绑死。
- **要求用户自行安装与启动官方 MCP 进程**：否决。脱离 Host 连接上下文与作用域凭据，MCP 进程不具备产品语义。
