---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# Office 插件：技能内容以 officecli 为权威，预览寿命由观看行为决定

## Context

官方插件 `dimo.office` 在 [ADR-0069](0069-everything-is-a-plugin-platform.md) 的公开插件契约内提供 Office 文档（`.docx` / `.xlsx` / `.pptx`）的 `officecli watch` 实时预览与专项创作技能。为避免技能文本与锁定版本 `officecli` 脱节、预览在用户正常阅读时被固定 TTL 强杀，以及插件配置项与宿主脱节，本决定固定技能构建溯源、可续租预览生命周期与配置接线规则。所有预览宿主改进落在通用的 `crates/plugins/src/process_preview_host.rs`，不向 Office 开放专用宿主特权。

## Decision

### 1. 技能在构建期由锁定版本的 `officecli` 生成

`contents/skills/` 下的全部 Office 技能（覆盖 `officecli` 提供的完整技能集，包括 `pptx`、`pitch-deck`、`morph-ppt`、`morph-ppt-3d`、`word`、`academic-paper`、`excel`、`financial-model`、`data-dashboard`）在构建期通过锁定版本的 `officecli load_skill <id>` 自动生成，并纳入 `content.index.json` 与 `package.lock.json` 内容寻址锁，禁止手写维护副本。

选择**构建期而非运行期同步**以维护插件包的内容完整性锁：升级 `depends/runtimes/officecli.json` 中的 `officecli` 版本时，必须在同一次插件发布中重新生成全部技能产物，确保技能描述与运行期锁定的二进制能力严格一致。

### 2. 预览寿命由观看行为驱动（可续租空闲超时）

`crates/plugins/src/process_preview_host.rs` 中的预览租约采用**可续租空闲回收**语义而非绝对寿命上限：

- 活跃预览面板在存活期间以显著小于空闲阈值的间隔定期续租；宿主按「最后一次续租之后经过的空闲时长」判定过期。
- 面板正常卸载时仍执行显式关闭；续租超时作为兜底，用于回收标签崩溃、断连或进程异常退出时未能送达的关闭请求。
- 租约续期失败时向用户展示明确的预览过期提示并支持重载，不呈现白屏。

### 3. 插件配置项 `idleTimeoutMinutes` 真实驱动宿主租约

插件 `config.json` 中声明的 `idleTimeoutMinutes`（1–60 分钟，默认 10）由宿主读取并作用于该插件的预览租约。内置常量 `PREVIEW_LEASE_TTL` 仅在插件未声明空闲配置时作为兜底默认值，不得覆盖插件配置；配置变更作用于后续新打开的预览，不影响已打开的预览。

### 4. 文档准确描述真实产品闭环

插件 README 清晰表达真实工作流：Agent 借助锁定版本的 `officecli` 与生成技能就地修改 `.docx` / `.xlsx` / `.pptx`，预览面板通过 `watch` 自动刷新；预览面板自身只读，不接受键盘编辑。

### 5. 拒绝一次性 HTML 渲染降级路径，并发上限按实测约束

- 不引入 `officecli view html` 一次性渲染作为 watch 失败时的降级路径：一次性全量读取 OpenXML zip 会在 Windows 上与正在写入同一文件的 Agent 发生文件锁竞争。`watch` 启动失败时明确报错并提供重试。
- `maxConcurrentPreviews` 按真实进程与端口资源开销实测校准，不盲目放大。

## Consequences

- Office 技能随 `officecli` 版本原子演进，彻底消除手写技能过时与覆盖不足。
- 可续租空闲超时与配置接线作为平台级能力在 `process_preview_host.rs` 生效，惠及全部声明 `artifact.preview` 的插件。
- 长时间打开文档预览的会话会持续持有对应 `watch` 进程直至关闭或真正空闲超时，符合用户预期。

## Considered Options

- **运行期从用户 `PATH` 上的 `officecli` 同步技能**：否决。破坏插件内容寻址锁，且用户环境中的版本与插件锁定版本可能不一致。
- **保留手写技能副本仅扩充数量**：否决。无法根治 `officecli` 升级后的命令用法漂移。
- **简单调大固定 `PREVIEW_LEASE_TTL`**：否决。仍属绝对寿命上限，未修正「是否仍有人观看」的根本判据。
- **为 Office 单独实现宿主预览通道**：否决。违反 [ADR-0069](0069-everything-is-a-plugin-platform.md) 的无特权插件原则。
