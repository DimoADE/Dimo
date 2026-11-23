---
status: accepted
date: 2026-08-13
decision-makers: Dimo maintainers
---

# 产品中心的 Plugin Package、内容与配置模型

Dimo 插件面向用户的产品界面与作者公共包布局以“完整功能产品”为中心设计，而非以内部扩展点（App / Agent contribution、激活代或 Runtime 锁数量）解释插件。内核生命周期与 SDK 边界见 [ADR-0046](0046-full-stack-plugin-platform-and-isolated-sdk.md)，全信任执行模型见 [ADR-0048](0048-full-trust-plugin-execution-model.md)，市场与安装预览流程见 [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)。

## Decision

1. **不可拆分的产品视角**：Dimo Plugin 在产品界面中作为单一完整产品呈现，不按“平台扩展 / Agent 扩展”切分用户分类。
2. **根 `README.md` 与一句话摘要**：每个包必须包含根 `README.md`；其 frontmatter 中的 `summary` 是独立的一句话简介元数据（不从正文或标题推断），供目录列表与详情页标题区展示；正文作为用户说明入口。
3. **统一内容目录（`contents/`）**：可供用户或 Agent 阅读、使用的 Skill、MCP、Hook、Workflow、模板与其他资源统一置于根 `contents/`，构建时生成结构化内容索引并由 Host 校验后通过 Product Detail DTO 暴露（UI 不直接读取源码路径）。
4. **清晰包布局**：依赖描述位于根 `depends/`，作者源码入口位于 `runtime/`，发布构建物位于 `dist/`。
5. **配置单一真相源（`config.json`）**：根 `config.json` 是用户配置的唯一事实，由 manifest 内联 schema 校验并经 Host 原子写回；它是可变用户数据，不计入 executable digest 或 `ActivationGeneration`，插件更新时保留并重新校验用户配置而不静默覆写。
6. **面向产品的 Manifest 术语**：`.dimo-plugin/plugin.json` 使用 `integrations` 与 `dependencies` 描述内部接线；Plugin Kernel 可在内部编译为私有 IR，但不得将该 IR 暴露为公共包格式或用户信息架构。
7. **精简目录与详情信息架构**：设置 → 插件提供“已安装”与“插件市场”两个目录 Tab（[ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)），采用单列列表；点击条目进入独立详情页，仅包含“内容”与“配置”两个主要 Tab（配置页可由插件提供自定义详情扩展面，仍以 `config.json` 为真相源）。`ActivationGeneration`、contribution、handler 与 Runtime 锁属于诊断视图，不干扰常规详情页。
8. **Agent 原生插件独立边界**：Codex、Claude Code 等 Agent-native plugin 不复用 Dimo 产品详情页，而是在“设置 → Agent → 对应 Agent”底部以默认折叠的列表加预览呈现（仅展示 Skill、MCP、Runtime、Hook 与 Workflow），使用独立 DTO 避免跨界泄漏 Dimo App 或产品包诊断术语。
9. **结构化动作统一为 Plugin Workflow**：可复用的结构化操作统一建模为 `contents/workflows/` 中的 Plugin Workflow，不再定义独立的公共 `PluginAction` 概念。

## Consequences

- Plugin SDK、CLI scaffold、官方插件、Host DTO 与设置 UI 共用同一公共包布局与产品术语，不维护双套面向作者的 manifest 约定。
- 用户在设置中看到的是清晰的功能说明、内容资源与可编辑配置，而开发者与运维仍可在诊断界面获取完整底层证据。
