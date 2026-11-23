---
status: accepted
date: 2026-07-29
decision-makers: Dimo maintainers
---

# Agent 版本证据可以缺省但不能冲突

Dimo 在 `InstallationLock` 中分别记录来源声明版本、实际解析的制品/包版本、初始化握手报告版本与内容指纹；版本证据允许合理缺省，但任何已观测证据之间不得相互矛盾。

## Decision

- **分项记录与一致性校验**：`npx` 与 `uvx` 分发必须解析为精确包版本。安装与更新期间取得的所有版本证据（Registry/Profile/用户声明版本、解析制品版本、握手报告版本）必须彼此一致；出现任何冲突均按元数据不一致处理，隔离新产物并中止安装或更新，不得用一个值静默覆盖另一个值。
- **允许合理的版本缺省**：ACP 仅建议 Agent 在 `initialize` 中返回 `agentInfo.version`，因此普通 Registry Binary 未报告运行时版本时不单独判定失败；Dimo 以声明版本配合首次指纹（TOFU SHA-256，见 [ADR-0017](0017-binary-integrity-has-two-trust-levels.md)）锁定内容，并在界面明确展示“运行时未报告版本”。
- **组件级验证规则**：Built-in Agent Profile 可将运行时或 ACP 适配器的版本报告设为必需项。在 ACP 通道中，自带 vendor CLI 的适配器型 Agent 仅验证适配器本身，其余适配器型 Agent 分别验证两个组件。
- **隔离上游漂移**：已锁定安装之后发生的上游 Registry 元数据漂移不改变现有 `InstallationLock`，但在元数据矛盾消除前不提供更新。

## Consequences

- 避免用不准确的猜测版本掩盖上游打包错误或供应链漂移。
- 既兼容尚未实现完整 `agentInfo.version` 的社区 Binary，又对可验证字段保持严格一致性门禁。
