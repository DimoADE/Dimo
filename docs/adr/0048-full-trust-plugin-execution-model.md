---
status: accepted
date: 2026-08-13
decision-makers: Dimo maintainers
---

# Dimo Plugin 采用全信任执行模型

Dimo 面向本地开发者主动安装的 IDE 级插件生态，其信任模型与桌面开发工具一致：插件代码属于安装物本身，用户在明确预览并确认后安装或启用即构成信任决定，优先保障插件能力完整性、跨平台一致性与开发体验。

## Decision

1. **单一 Full Trust 执行模型**：用户安装或启用 Dimo Plugin Package，即信任其 Worker、App 扩展面与声明的 Runtime 以与 Dimo Host 相同的本机文件、网络、环境变量与进程权限运行。
2. **显式安装预览确认，无逐项权限弹窗**：市场、`.vxp` 与 CLI 安装前必须向用户展示包含身份、来源与能力的安装预览和 **Full Trust 确认弹窗**（见 [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)）。产品界面不存在逐 capability 审批、scope 授权、permission delta 或 Trusted Native 二次弹窗；manifest 中的 `permissions` 仅作声明式元信息与文档说明，不构成运行时权限门禁。
3. **Worker 进程用于生命周期与崩溃隔离**：Plugin Worker（Node / Python / Rust）运行在独立进程中，目的仅是支持 candidate-first 热更新、超时终止、崩溃隔离与干净 dispose；Host 不施加 Seatbelt、bubblewrap、Node Permission Model、环境变量清空或 Windows fail-closed OS 沙箱。
4. **App 扩展面容器用于 UI 生命周期管理**：iframe 等独立 App surface 容器与版本化 bridge 用于管理 mount、revoke 与 `ActivationGeneration` 切换，不作为限制插件代码的安全边界。
5. **保留可靠性与可复现契约**：Host RPC 的 contribution 身份校验、handler 注册校验、代际路由、内容寻址 Runtime 锁与探针、包 digest、publisher 身份、原子更新、失败保留旧代、回滚与操作审计全部保留——它们保障 API 正确性、可复现性与可诊断性，而非本机权限封堵。

## Consequences

- 插件作者无需设计 capability scope、授权迁移或 Trusted Native 特殊路径，CLI `dev`、linked reload 与常规启停共享同一直接路径；Windows、macOS 与 Linux 采用一致的 Worker 启动模型。
- 已安装插件与 Dimo Host 拥有同等本机能力，因此安装确认与文档必须诚实告知这是全信任生态，绝不宣称插件运行在安全沙箱中。
- 若未来引入面向不受信任第三方的隔离插件类型，须通过新 ADR 建立独立的受限 package class 与沙箱运行时，不得在当前全信任模型上零散拼凑权限弹窗。
