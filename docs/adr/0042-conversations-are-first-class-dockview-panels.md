---
status: accepted
date: 2026-08-09
decision-makers: Dimo maintainers
---

# Conversation 是一等 Dockview 面板

在多会话 IDE 工作台中，每个 Conversation 都是一等 Dockview panel，由 Dockview 统一承担标签、分屏、拖拽、序列化与恢复，不在固定右侧区域内另建第二套分屏框架。

## Decision

- **一等面板与同屏分组**：Conversation 默认在右侧打开，并可自由拖入编辑区、组成标签组或建立左右/上下分屏；同屏最多支持三个 Conversation group，与编辑区分组上限一致。每个 panel 拥有独立的事件订阅、滚动位置、Composer 草稿视图与在途 Turn 状态。
- **窗口内唯一实例与聚焦导航**：同一个 Server-bound window 内，一个 Conversation 至多对应一个 panel；重复打开或通过 `workspace.focusConversation` 导航时，只切到工作区表面并聚焦已有 panel，不新建重复面板，也不将时间线嵌进插件 Tab。不同窗口与不同设备可同时查看同一 Conversation，并通过服务端事件序列协调。
- **视图操作与领域解耦**：关闭、移动或重排 panel 只改变本地布局，绝不取消在途 Turn、不关闭 Agent 会话、不删除 Conversation。
- **本地布局持久化**：Dockview 布局、打开的面板、标签顺序、分组尺寸、激活标签与滚动位置仅保存在当前设备，按稳定 Host 身份（[ADR-0059](0059-host-identity-and-pairing-invitation.md)）、Project 与窗口身份隔离，不经 Host 同步，不因 Server Profile 改名或地址更新而丢失。
- **服务端共享草稿**：Composer draft 属于 Host 上的 Conversation，在已授权桌面、浏览器与移动端（iOS / Android）间共享。每次保存携带 `base_revision`，冲突时同时保留服务端版本与本机未保存版本并由用户选择或合并，禁止静默 last-write-wins；Turn 提交成功后仅在 revision 匹配时清除草稿；本地附件成为 Host 可识别 Artifact 后方可跨设备引用。

## Considered Options

- **在固定右侧会话槽位内嵌套自定义 splitter**：否决。会制造第二套布局、拖拽、持久化与无障碍模型，并固化单会话 DOM 假设。

## Consequences

- Dockview 成为工作台唯一的布局权威，默认单会话体验零额外成本，多会话并行查看与 Spatial Canvas 联动均基于同一会话模型工作。
