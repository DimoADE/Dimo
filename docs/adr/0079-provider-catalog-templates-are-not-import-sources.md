---
status: accepted
date: 2026-09-13
decision-makers: Dimo maintainers
---

# 供应商预置目录是无密钥填表模板，不是导入源

## Context

设置 → Agent → 鉴权 → 供应商的新建表单提供按 Agent 整理的无密钥填表模板：内置预置随 Host 开箱可用（[ADR-0088](0088-built-in-provider-presets.md)），第三方插件可通过 `provider.model.catalog` 贡献点追加额外模板。用户点选模板仅填充表单草稿，补齐密钥并保存后才成为该表面的已保存连接。Runtime 权威仍是 Agent 原生配置（[ADR-0022](0022-agent-native-configuration-is-authoritative.md)、[ADR-0063](0063-model-provider-presets-not-cc-switch.md)），Dimo 不引入本地协议转换代理或全量覆盖原生快照。

本 ADR 划定无密钥模板目录与外部导入源（`provider.model.importSource`）的边界，并固定目录 DTO、聚合、过滤与排序不变量。

## Decision

### 1. 独立贡献点 `provider.model.catalog`，永不复用导入源

`provider.model.importSource` 的产品动词是「收成已有连接」（含密钥、缺 Key 禁止勾选、导入即保存但不绑定，见 [ADR-0063](0063-model-provider-presets-not-cc-switch.md)）；`provider.model.catalog` 的产品动词是「用无密钥模板填充空白新建表单」。两者语义互斥，永不复用或扩展 `provider.model.importSource` 承载模板目录。

同时与既有探测/目录命令保持清晰区分，避免客户端或设置面撞名：

- `provider_catalog_list`（scope `plugin.read`，挂在插件控制面 API）：列出插件贡献的模板目录；
- `agent_model_provider_catalog`：对已填 URL/Key 探测 `/models`；
- `opencode_provider_catalog`：`models.dev` 官方 Provider 目录。

### 2. Host 拥有表单与保存链路，插件只提供静态 descriptor

卡片列表、保存、绑定、测连与原生投影全部由 Host 闭环完成；插件通过静态 `resource` 贡献目录数据（v1 不声明 Worker `handler`），Host 原生渲染 descriptor，插件不替换新建表单，也不调用 `provider.presets.save` / `bind`。

### 3. Catalog DTO 按表面判别联合，已保存预设保持精简

目录模板按目标表面采用判别联合 `reusable | opencode | dsh`，仅携带该表面保存时认识的字段。可复用 Model Provider 的持久化存储维持名称、端点、模型映射与凭据；官网链接、候选 URL 与密钥提示字段仅在填表期展示，不写入已保存预设。OpenCode / MiMo 保留模型列表，DeepSeek Harness 自定义保留备注。

### 4. 「自定义」固定由 Host 所有

可复用 Model Provider 与 DeepSeek Harness 新建子页列表顶部永远固定 Host 的「自定义」入口；OpenCode / MiMo 的空白连接表单即为自定义。任何插件不得移除或隐藏「自定义」。

### 5. 按规范 `AgentKind` ID 严格分区

每份目录按 Dimo 规范 Agent ID 精确匹配过滤，禁止别名猜测或特判（例如 Gemini 相关目录显式声明 `antigravity` 而非 `gemini`）。不支持供应商模式的 Agent 返回空列表而不报错；无法解析的未知 Agent ID 返回错误。

### 6. 模板清洗与可投影性契约

从外部预置源（如 CC-Switch 固定快照，见 [ADR-0088](0088-built-in-provider-presets.md)）转换模板时，只保留能够投影到对应 Agent 已适配原生字段的条目；剥离 affiliate 参数、OAuth 与本地协议转换字段、赞助商促销文案与徽章；官方订阅与官方 API 预置不进入第三方供应商目录。

### 7. 合并聚合、去重与 OpenCode 表面规则

- **内置优先、插件追加、不去重**：Host 内置预置排在前面（[ADR-0088](0088-built-in-provider-presets.md)），所有已启用插件贡献的模板按来源标注追加其后；名称或 URL 相同亦并列保留，不按安装顺序静默覆盖，用户通过启停插件自主取舍。插件目录加载失败不影响内置预置正常展示。
- **OpenCode / MiMo 合并进 `models.dev` 列表**：插件模板直接追加在现有 `models.dev` 列表之后并标注来源，不另开第二套选择器，不替换同名 `models.dev` 条目。

### 8. 分档枚举与默认排序

模板层次编码为 `category`: `"official" | "prime" | "partner" | "community"`（省略或未知值统一归为 `"community"`），不输出赞助商布尔或促销视觉徽章。Host 默认排序为：`official` → `prime` → `partner`（前三档各自保持源数组顺序，不按名称重排）→ `community`（按 `en` locale 显示名排序）。可复用与 DSH 选择器支持切换按名称打平排序，并可恢复默认排序。

## Consequences

- Host 内置预置与插件追加模板共享同一判别联合 DTO、排序规则与填表体验，禁用或卸载插件后其模板原子消失，已保存连接与绑定不受影响。
- `provider.model.importSource` 保持纯粹的「导入已有连接」语义，与无密钥模板互不干扰。
- 已保存预设存储与原生投影保持精简，不会因填表辅助元数据膨胀。

## Considered Options

- **复用 `provider.model.importSource` 承载无密钥模板**：否决。缺密钥在导入中是禁用项，在模板中是正常态，二者语义冲突。
- **允许插件以 App surface 替换供应商新建表单**：否决。会制造第二条保存/绑定路径并破坏卸载回退一致性。
- **保留 CC-Switch 的 OAuth / 协议转换与赞助商促销字段**：否决。脱离本地代理无法工作，且破坏设置面克制与诚实原则。
- **对所有分档统一按名称排序**：否决。前三档按源顺序分区拼接、仅 `community` 按名称排序，既保结构化优先级又不引入促销分组 UI。
