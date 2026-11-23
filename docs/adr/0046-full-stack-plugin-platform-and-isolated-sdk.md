---
status: accepted
date: 2026-08-13
decision-makers: Dimo maintainers
---

# 全栈 Plugin Package、原子激活代与版本化 SDK

Dimo 以统一的 **v4 Plugin Package** 作为唯一产品扩展单元，将 App 扩展面、Agent 能力（Skill / MCP / Hook / Workflow）、Host 后台处理与外部 Runtime 收敛到单一 Plugin Kernel、原子 `ActivationGeneration` 与公共 SDK 契约之下；公共包布局与产品界面见 [ADR-0047](0047-product-centric-plugin-package-and-content-model.md)，全信任执行模型见 [ADR-0048](0048-full-trust-plugin-execution-model.md)，零官方特权与完整接管面见 [ADR-0069](0069-everything-is-a-plugin-platform.md)。

## Decision

### 1. 统一产品包与 v4 Manifest

- **单一扩展单元**：Dimo Plugin Package 是产品级安装、启停、更新、诊断、回滚与卸载的唯一单元。包内只需包含至少一项当前 Host 可识别的有效 integration（不再要求必须含 Skill），即可进入统一生命周期管线。
- **与 Agent 原生插件分界**：Codex、Claude Code 等 Agent 的原生插件仍归属各自原生存储与信任机制，在“设置 → Agent → 对应 Agent”中管理，不自动获得 Dimo App/Worker 执行权。
- **静态声明边界**：`.dimo-plugin/plugin.json` v4 声明 `manifestVersion`、`apiVersion`、稳定 `publisher` + `id`、`version`、Host 兼容范围、可选 Worker/App entrypoints、`integrations` 以及确定性的 `dependencies`（目标平台分发、完整性证据、入口与 probe）。Worker 启动后仅可为已声明 contribution 绑定 handler；未知的必需 contribution 或无法识别的可执行入口直接判为 incompatible。`manifestVersion`、`apiVersion`、`minimumHostVersion` 与包版本独立演进。

### 2. Contribution Registry 与 Candidate-First 原子激活代

- **单一运行时目录**：`crates/plugins`（Plugin Kernel）统一拥有包检查、安装、Runtime 解析、candidate 激活、generation 发布、禁用、回滚与操作审计；`Contribution Registry` 仅对外暴露当前已发布 `ActivationGeneration` 的 descriptor、handler 路由、readiness 与失败证据。所有消费方按扩展点消费，严禁按插件 ID 特判。
- **确定性冲突解析**：Contribution ID 在 `publisher + plugin ID` 下命名空间化；同一扩展点的冲突解析必须确定且可解释，用户显式默认选择独立持久化，绝不按安装顺序静默覆盖。
- **Candidate-First 事务发布**：安装、更新与 linked-dev reload 共享同一流程：
  1. 物化不可变包快照（或校验 linked 开发目录）并验证 digest、兼容性与静态声明；
  2. 解析并验证 Runtime 锁；
  3. 在不可见 candidate generation 中启动 Worker、绑定 handlers 并 probe Runtime；
  4. 校验实际注册是声明子集且所有必需项就绪；
  5. 在一次事务中原子发布包版本、Runtime 锁与新 `ActivationGeneration`；
  6. 新调用路由至新代，旧代排空在途调用与 preview leases 后执行 abort/dispose 并回收资源。
- **失败保护与双轨生效**：candidate 发布前失败时，旧 generation 继续无缝服务，不残留部分 UI、工具或数据库写入；非必需 contribution 失败进入 `active_degraded` 仅隔离该项。UI 与 Provider 贡献启用即生效、禁用即原子撤下；Agent 贡献（Skill、MCP、Hook）按会话诚实性规则应用于新开或重绑定的会话（[ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)）。

### 3. 全信任隔离生命周期与内容寻址 Runtime

- **生命周期隔离（全信任）**：按 [ADR-0048](0048-full-trust-plugin-execution-model.md)，Worker 运行在独立进程（Node / Python / Rust），App surface 运行在独立 frame、Module Federation 面板或宿主渲染 descriptor 上；独立进程与 frame 服务于热更新、超时终止、崩溃隔离与资源回收，而非 OS 安全沙箱或逐 capability 权限门禁。
- **内容寻址与引用计数 Runtime**：托管 Runtime 以 `runtime id + version + target + digest` 标识，安装在 Dimo Host 的版本化目录中并记录精确 `RuntimeInstallationLock`。不同插件可并存使用同名 Runtime 的不同版本，更新发布新代后按引用计数安全回收无引用旧版本，绝不因版本冲突级联删除其它插件。外部 Runtime 支持只读探测与锁定而不夺取其文件所有权；向用户终端导出稳定 shim 是显式可选贡献，非安装默认副作用。

### 4. 版本化 SDK、CLI 与零特权官方插件

- **公共工具链**：提供 `@dimoai/plugin-sdk`（TypeScript，含 Worker/App/Testing 能力）、`@dimoai/plugin-sdk-python`、`crates/plugin-sdk`（Rust）、`@dimo/plugin-contract` 以及 `dimo-plugin` CLI（`init`、`dev`、`validate`、`test`、`build`、`pack`、`install --link`、`doctor`），生成确定性 `.vxp` 包与内容摘要，并通过本机契约测试与随版本分发的插件开发 Skill 指导创作。
- **零官方特权与 Host Seam**：`dimo.office` 等全部 16 个官方插件与第三方插件使用完全相同的 v4 manifest、SDK、Runtime 锁与 contribution 接缝（由 `pnpm run plugin:no-privilege` 守卫）。Plugin Kernel 位于 `ApplicationCore`（[ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)），Worker 与 Runtime 始终运行在 Dimo Host 上，所有客户端通过 `BackendTransport` 按协商能力渲染扩展面。

## Considered Options

- **仅在旧 Agent Skill 插件上附加浅层 `app` 字段**：否决。保留 Skill 必选限制与双套控制面，无法统一 App 与 Agent 生命周期。
- **为 App 插件与 Agent 插件建立两套平行系统**：否决。同一产品被拆成两套版本、启停与升级状态，无法原子发布与回滚。
- **继续使用用户全局 Runtime 并在冲突时删除依赖插件**：否决。破坏版本并存与原子升级。

## Consequences

- 第三方与官方插件在单一内核、原子代际切换与确定性 Runtime 锁上获得一致的开发与运行体验。
- 宿主核心保持最小化，文件预览、主题、连接器、办公文档与工作流创作等能力均可作为一等插件独立演进。
