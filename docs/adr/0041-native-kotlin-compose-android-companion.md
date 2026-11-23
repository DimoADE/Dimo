---
status: accepted
date: 2026-08-09
decision-makers: Dimo maintainers
---

# Android Mobile Companion 采用原生 Kotlin 与 Jetpack Compose

Android Mobile Companion（`mobile/android/`）使用原生 Kotlin 与 Jetpack Compose 构建，与原生 SwiftUI iOS Companion（`mobile/ios/`，[ADR-0084](0084-native-swiftui-ios-companion.md)）共享版本化 Remote Protocol v1 schema、生成模型、事件 fixture 与跨平台兼容性验收套件，不抽象共享跨平台 UI 运行时。

## Decision

- Android 客户端直接使用原生 Kotlin、Jetpack Compose 与 Android 平台能力实现 Keystore 凭据保护、生命周期管理、前台服务持续连接、本地通知与无障碍支持。
- 协议契约完全由 `crates/remote-protocol` 派生的版本化 schema 驱动；Kotlin 客户端不得手写与 Rust schema 并行的协议权威，也不得要求 Dimo Host 为 Android 专属 UI 状态增加专用端点。
- 与 iOS 客户端保持完全对等的协议契约与 `Companion Device` 权限边界（[ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)、[ADR-0054](0054-host-family-distribution-and-client-surfaces.md)），但不强制共享界面代码。

## Considered Options

- **采用 Kotlin Multiplatform 或其它跨平台 UI 框架**：否决。将平台生命周期、安全凭据存储、后台连接与通知差异塞入共享 UI 层会增加维护复杂度，而协议与模型层共享已覆盖核心跨端复用价值。

## Consequences

- Android 与 iOS 各自发挥原生交互、性能与系统集成优势，同时通过同一套 Remote Protocol v1 契约测试保证服务端与双端行为一致。
