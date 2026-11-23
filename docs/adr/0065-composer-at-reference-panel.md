---
status: accepted
date: 2026-08-26
decision-makers: Dimo maintainers
---

# Composer 以 `@` 承载引用面板，`&` 在新会话即可用

## Context

Composer 若为每类引用对象各分配独立触发符，会持续增加用户记忆负担并挤压触发字符空间。同时，在「协作空间」开启后，尚未建立 Agent binding 的新建 Conversation 同样需要支持 `&Agent` 委派提及，且多 Agent 委派配置页在已启用 Agent 数量增多时必须保持可扫读。

## Decision

### 1. 触发符职责划分

| 触发符 | 职责 |
| --- | --- |
| `@` | 结构化引用面板（Tab：文件、项目、会话、提交、指令） |
| `/` | 斜杠命令（Plugin Command 与 Agent Command） |
| `$` | 技能 / 变量 |
| `&` | Agent Mention（委派建议，见 [ADR-0031](0031-llm-mediated-delegation-and-ampersand-agent-mentions.md)） |
| `#` | 不作为独立触发符；指令/标签统一归入 `@` 的「指令」Tab（历史 `[#:…]` 草稿继续兼容解析） |
| `!` | 保留兼容触发符，不进入 `@` 面板 |

`&` 始终表示「建议父 LLM 考虑委派」，序列化为 `[&Name](dimo://agent/<id>)`，不将 Agent 混入 `@` 引用面板。

### 2. `@` 引用面板与序列化契约

输入 `@` 弹出与 Composer 同宽的引用面板，固定五个 Tab 顺序：

1. **文件** — 当前工作区/仓库文件引用
2. **项目** — Dimo 中现存的 Project
3. **会话** — 可引用的 Conversation
4. **提交** — 当前仓库 `git log`
5. **指令** — 标签与内置指令

每个 Tab 独立检索、独立计数、至多返回 50 条；空 Tab 仍显示，支持 `Tab` / `Shift+Tab` 切换、`Enter` 选中。无仓库时文件与提交为空，会话与指令仍可用。

序列化统一采用「结构化 token + Markdown 发送」：

| 种类 | Composer 序列化值 | Agent 语义 |
| --- | --- | --- |
| 文件 | `[@:name](relative/path)` | 工作区相对文件路径引用 |
| 项目 | `[name](dimo://project/<uuid>@<encoded-path>)` | Token 为 `@name`，Hover 展示绝对路径；发给 Agent 时展开为绝对路径 |
| 会话 | `[title](dimo://conversation/<uuid>)` | `get_session_info` 可直接读取的会话 URI |
| 提交 | `[shortSha](dimo://commit/<repoId>@<sha>)` | 提交身份，正文附带短 SHA 与说明 |
| 指令 | `[#:name]([[tag:...]])` | 标签附录展开 |

会话 URI 统一使用 `dimo://conversation/<uuid>`，不另造 `dimo://session/`。

### 3. `&` 提及的出现条件

当 Host 内置设置「协作空间」（[ADR-0055](0055-official-product-mcp-activation.md)）开启时：

- **尚无 Agent binding**（新建 Conversation，尚未首次连接绑定）→ 显示 `&`；后续新建或恢复会话按当前开关注入协作 MCP。
- **已有 binding 且 `delegation_mcp_delivered` 为真** → 显示 `&`。
- **已有 binding 但未投递**（协作空间开启前已存在的旧会话）→ 隐藏 `&`，直到用户重新绑定会话。
- **协作空间关闭** → `&` 立即隐藏。

手工输入且唯一命中已启用、已就绪 Agent 的 `&Name` 或 `&agent_kind` 会与列表选中等价地转为 Mention Token；正忙于其他会话的就绪 Agent 仍可被提及。

### 4. 子智能体默认配置列表

`agentDefaults` 通过 Host 通用 schema 渲染器编辑，默认折叠为单行列表（一行一个 Agent），仅在用户展开时探测并展示该 Agent 的 session mode 与 config options，不按插件或功能 ID 硬编码特判配置页。配置修改仅作用于之后委派拉起的子会话。

## Consequences

- `@` 面板统一承载除斜杠命令、技能与 `&Agent` 外的全部引用对象，后续新增引用类型只需扩展 Tab 而无需侵占新触发符。
- Composer 与时间线用户消息统一解析并渲染文件、项目、会话、提交、指令与 `&Agent` 结构化 token。
- `conversation_list_recent` 通过统一 Host 命令注册表暴露，供所有客户端表面的 `@` 会话 Tab 检索。

## Considered Options

- **将 Agent 合并进 `@` 面板并移除 `&`**：否决。与 [ADR-0031](0031-llm-mediated-delegation-and-ampersand-agent-mentions.md) 冲突，混淆委派建议与普通上下文引用。
- **同时保留 `#` 独立触发符与 `@` 指令 Tab**：否决。双入口增加心智与维护负担。
- **把 `agentDefaults` 折叠列表做成独立 App surface**：否决。现有 schema 渲染器即可直接编辑配置真相源，无需引入额外渲染面。
