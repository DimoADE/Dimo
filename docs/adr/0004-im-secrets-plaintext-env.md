---
status: accepted
date: 2026-07-04
decision-makers: Dimo maintainers
---

# IM 渠道密钥以 `0600` 明文存储于 `~/.dimo/.env`

Chat Channel（IM 渠道）的密钥由 `services::chat_delivery` 统一管理，以明文键值对形式存储在 `~/.dimo/.env`（Unix 权限 `0600`），有意不接入系统钥匙串。

## Decision

- 所有 IM 渠道密钥集中在 `~/.dimo/.env`，由 `services::chat_delivery` 读取与原子写回，避免在命令层散落自建 JSON 文件。
- 明确选择本地明文存储（不经系统钥匙串加密），以换取零平台依赖、无头服务器（`dimo-server`）行为一致、以及可直接编辑与备份的简单性。

## Consequences

- 收录范围严格限定为 IM 渠道密钥；模型供应商 API Key、Agent 原生配置凭据与 MCP 环境变量各自保留在其既有存储边界内，不并入 `~/.dimo/.env`。
- 若未来需要切换到系统钥匙串或外部凭据管理后端，改动面收敛在 `services::chat_delivery` 的单一读写边界内。
