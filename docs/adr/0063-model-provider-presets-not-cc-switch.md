---
status: accepted
date: 2026-08-26
decision-makers: Dimo maintainers
---

# Model Provider 管理保持 Agent 结构化预设，CC Switch 只作导入源

## Context

设置 → Agent → 鉴权 → 供应商需要管理可复用的 Model Provider 预设（卡片列表、启用即互斥绑定、新建与编辑走同栏子页）。该能力不恢复全局「模型提供商」页，也不采用 CC Switch 的全量覆盖原生文件与本地协议转换代理架构。

## Decision

1. **原生配置为 Runtime 权威**：Agent 原生配置仍是运行期唯一权威（[ADR-0022](0022-agent-native-configuration-is-authoritative.md)）；绑定预设仅投影该 Agent 已适配的原生字段（ADR-0037）。不引入截获 CLI 的本地反向代理、Chat Completions 协议转换路由或跨应用统一同步层。
2. **可扩展的外部导入源**：外部供应商导入通过 `provider.model.importSource` 插件贡献点扩展（[ADR-0069](0069-everything-is-a-plugin-platform.md)）。本机 `~/.cc-switch/cc-switch.db` 作为内置一次性只读导入源：提取已有连接的名称、端点、凭据与模型映射，经预览后默认跳过同名项，且**导入不自动绑定**、不改变当前生效配置。
3. **导入源与无密钥模板目录分离**：本 ADR 的导入动词是「收成已有连接」。供应商新建表单中的无密钥填表模板由 Host 内置预置（[ADR-0088](0088-built-in-provider-presets.md)）及插件 `provider.model.catalog` 贡献提供（[ADR-0079](0079-provider-catalog-templates-are-not-import-sources.md)），不走 `provider.model.importSource`。
4. **凭据不进剪贴板**：复制预设操作仅将不含密钥的结构化字段写入本机剪贴板。

## Consequences

- 各 Agent 的原生设备认证与配置边界保持完整，无需维护侵入式本地代理。
- 第三方插件可通过 `provider.model.importSource` 接入更多外部配置工具，同时复用 Host 统一的预览、校验与「导入不绑定」语义。
