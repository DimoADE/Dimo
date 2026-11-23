---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# Qoder 接入为一等 Agent，ACP 启动参数收敛到单一解析口

## Context

Qoder CLI 原生支持 ACP（`--acp` 走 stdio，支持内置工具、Subagent、MCP、权限配置、上下文压缩与多模态图片），并通过 npm 包 `@qoder-ai/qodercli`（同时暴露 `qodercli` 与 `qoder` 两个可执行名）公开分发。接入 Qoder 为内置一等 Agent 的同时，需要消除多处各自推导 ACP 启动参数的分散逻辑，并确保 Onboarding 展示的可用 Agent 列表与 `AgentKind` 内置名册保持单一事实来源。本决定遵守 [ADR-0002](0002-single-agent-identity-enum.md)、[ADR-0060](0060-agent-installs-use-user-environment.md) 与 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)。

## Decision

### 1. Qoder 作为内置 `AgentKind` 档案接入

新增 `AgentKind::Qoder`（规范串 `"qoder"`）并在 `BuiltInProfileCatalog::bundled()` 中提供 `qoder_profile()`（拓扑 `ProfileTopology::NativeAcp`）。内置档案完整表达 `external_candidates`、鉴权策略、原生 MCP、Skills 与历史路径，而非使用能力受限的社区预设。

### 2. 托管安装与外部检测

托管安装使用标准 `native_npx` 形态锁定 `@qoder-ai/qodercli`（携带 npm `dist.integrity` 校验和与 `["--acp"]` 启动参数，要求 Node `>=20`）。`external_candidates` 同时覆盖 `qoder` 与 `qodercli`，兼容用户自行安装的本机二进制。

### 3. ACP 启动参数单一解析口

`agents::acp_launch_args(profile, component)` 是解析 ACP 启动参数的唯一入口，供 `launch_gate` 与 Host Agent 管理命令统一调用。解析顺序固定为：

1. 优先读取 `ProfileExternalCandidate::acp_args`（描述该可执行文件如何以 ACP 模式启动）；
2. 回退到对应组件 `install_sources` 上锁定的参数。

当两者同时声明时必须完全相等，由单元测试 `acp_launch_args_have_one_answer_per_profile` 锁定，保证外部检测与托管安装启动同一行为，避免裸启进入交互式 TUI。

### 4. 鉴权策略与原生本机路径

- **鉴权模式**：仅声明 `official_subscription`（登录动作 `qodercli login`），设置页不展示 API Key 或供应商 Tab；`QODER_PERSONAL_ACCESS_TOKEN` 是无浏览器环境下的同账号个人令牌，不是独立官方 API Key 模式。
- **原生配置与扩展路径**：
  - Skills：`~/.qoder/skills/{name}/SKILL.md` 与项目级 `.qoder/skills/`；
  - MCP：`~/.qoder/settings.json` 中的 `mcpServers`；
  - 账号证据：`settings.json` 中的 `security.auth.selectedType`；
  - 会话历史：`$QODER_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl`（默认 `~/.qoder/projects/...`），结构与 Claude Code JSONL 同形；
  - 模型、权限与推理档位通过 ACP `configOptions` 进入 Composer，不在设置页复制配置副本。

### 5. Onboarding Agent 名册不变量

Onboarding 轮播中 `SLOT_B`（Dimo 可运行的 Agent）严格与 `BuiltInProfileCatalog` 中所有非测试内置 `AgentKind` 一一对齐，按 `AgentKind::ALL` 排序，并由 `EquationLine.test.ts` 的类型与枚举校验锁定。`SLOT_B` 展示的每一项都必须可在新建会话时选中；同时具备 IDE 与 Agent 身份的产品（如 Cursor、Qoder）在 `SLOT_A` 中复用 `kind: 'agent'` 图标标识。

## Consequences

- `AgentKind` 枚举与 `shared/types.ts`（`pnpm run generate-types`）、内置图标注册及 `ensure_current_built_ins` 同步覆盖 Qoder，无需额外数据库迁移。
- 所有走 ACP 通道的 Agent 共享单一 `acp_launch_args` 解析口，彻底消除外部检测与托管安装参数分叉。
- 新增或移除内置 `AgentKind` 时，Onboarding 名册在编译与单测阶段自动保持一致。

## Considered Options

- **以社区预设接入 Qoder**：否决。无法表达双 bin 候选检测、原生 MCP/Skills 与鉴权模式。
- **调用无校验和的远端安装脚本**：否决。违反 [ADR-0060](0060-agent-installs-use-user-environment.md) 与供应链完整性基线。
- **为 Qoder 单独增加第四处启动参数推导**：否决。必须收敛到单一解析口以根治分叉。
