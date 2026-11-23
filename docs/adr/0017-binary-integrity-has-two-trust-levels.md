---
status: accepted
date: 2026-07-29
decision-makers: Dimo maintainers
---

# Binary 完整性采用预期哈希与首次信任两级策略

对于以 Binary 分发形式安装的 Agent 可执行文件，Dimo 依据来源是否提供上游校验和，实施“预期 SHA-256”与“首次信任（TOFU）”两级完整性策略。

## Decision

- **预期 SHA-256（Built-in / 显式声明）**：Built-in Agent Profile 声明的 Binary 分发以及显式附带校验和的用户声明 Binary（见 [ADR-0036](0036-user-declared-acp-agents-use-locked-distributions.md)），必须在下载与启动门禁校验中严格匹配预期 SHA-256；缺失或不匹配时禁止执行。
- **首次信任（TOFU）**：官方 ACP Registry 当前不提供 Binary 校验和字段，因此普通 Registry Binary（以及未提供预期哈希的用户声明 Binary）采用首次信任策略：首次下载后、首次执行前计算 SHA-256 并写入 `InstallationLock`，此后的启动、修复与重新下载必须严格匹配该锁定指纹。
- **诚实来源标注**：TOFU Binary 仅标注为“Registry 来源·首次指纹”或“用户声明·首次指纹”，严禁宣称“Dimo 已验证”。
- **漂移即阻断**：同一锁定版本若发生磁盘内容篡改或哈希不匹配，立即阻断启动并标记需要修复，仅在用户显式更新版本或重置信任后方可继续。
- **包生态完整性**：`npx` 与 `uvx` 分发锁定确切包版本，并依赖对应包生态的完整性校验机制。

## Consequences

- 在官方 Registry 尚未普遍提供制品校验和的现实下，仍可防止下载后的本地替换与静默篡改。
- 来源可信度与完整性验证等级对用户透明可见，不制造虚假安全感。
