# Dimo Documentation

Welcome to the Dimo documentation hub. Every document describes **current `v0.5.2+` behavior or an active architectural contract**.

> **Looking for the full file map, directory rules, or categorized ADR list?** Start with [`docs/INDEX.md`](INDEX.md).

## 1. Product, Design & Domain Model

| Document | Purpose |
| :--- | :--- |
| [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) | Product introduction: Agent-Native development platform & Vibe Coding toolkit overview and quick start. |
| [`PRODUCT.md`](../PRODUCT.md) | Product charter: positioning, target users, anti-references, and product design principles. |
| [`DESIGN.md`](../DESIGN.md) | Frontend visual design single source of truth (macOS Tahoe opaque chrome/content tokens, palettes, radii, typography). |
| [`CONTEXT.md`](../CONTEXT.md) | Ubiquitous Language glossary across Conversation, Collaboration Space, Channel, Pulse Automation, Workflow, Plugin, Remote/Device, and Agent domains. |

## 2. System Architecture, Remote Protocol & Operations

| Document | Purpose |
| :--- | :--- |
| [`docs/architecture.md`](architecture.md) | End-to-end architecture: Single-Seam Rust Host (`dimo-server` + Electron thin shell), SQLite single-authority projection, Dual-Stage Workbench, Dedicated-Engine-first `AgentRuntime`, Pulse automation, Plugin Kernel, and 26-crate workspace map. |
| [`docs/protocol/v1/README.md`](protocol/v1/README.md) | Versioned Remote Protocol v1 OpenAPI, JSON Schemas, and generated TS/Swift/Kotlin models. |
| [`docs/guides/companion-apps.md`](guides/companion-apps.md) | Paired remote clients, pairing invitations, durable WebSocket attach/fold contract, and native iOS (`mobile/ios`) & Android (`mobile/android`) apps. |
| [`docs/guides/headless-server.md`](guides/headless-server.md) | Headless `dimo-server` deployment, `dimoai` CLI (`serve`, `list`, `install`), Docker, security boundaries, and upgrades. |
| [`docs/guides/agent-troubleshooting.md`](guides/agent-troubleshooting.md) | Diagnostic and recovery playbooks for agent installation, authentication, tools, and collaboration issues. |

## 3. Plugin Platform v4 (`Everything is a Plugin`)

| Document | Purpose |
| :--- | :--- |
| [`docs/plugins/README.md`](plugins/README.md) | Entry point for plugin users, authors, and platform contributors. |
| [`docs/plugins/user-guide.md`](plugins/user-guide.md) | Installing, enabling, configuring, updating, and removing plugins via UI or `dimo plugin` CLI. |
| [`docs/plugins/developer-guide.md`](plugins/developer-guide.md) | Authoring full-trust v4 packages with `@dimoai/plugin-sdk` (`v2.0.0`), Python/Rust Worker SDKs, `dimo-plugin` CLI, and live `--dev` linking. |
| [`docs/plugins/official-plugins.md`](plugins/official-plugins.md) | Reference catalog of Dimo's 15 official plugins (`plugins/*`). |
| [`docs/plugins/package-v4.md`](plugins/package-v4.md) | Normative `.dimo-plugin/plugin.json` v4 package layout, `README.md` summary frontmatter, `contents/`, and root `config.json`. |
| [`docs/plugins/sdk-and-cli.md`](plugins/sdk-and-cli.md) | `@dimoai/plugin-sdk` API exports and `dimo-plugin` author CLI reference. |
| [`docs/plugins/platform-architecture.md`](plugins/platform-architecture.md) | Plugin Kernel internals: Activation Generations, Runtime locks, full-trust Worker/App surfaces, and Remote Host execution seam. |
| [`docs/plugins/contract-bindings.md`](plugins/contract-bindings.md) | Generated contract matrix of the 23 contribution kinds (`L0`–`L3`) and Host API bindings. |

## 4. Specs, ADRs, Security & Releases

| Location | Purpose |
| :--- | :--- |
| [`docs/specs/`](specs/) | Active technical specifications (`agent-driver-engine.md`, `context-menu-surfaces.md`, `cross-agent-continuation.md`, `prepared-acp-session-controls.md`, `pulse-automation-engine.md`). |
| [`docs/adr/`](adr/) | 78 active Architectural Decision Records (`0001`–`0092`) — see categorized list in [`docs/INDEX.md`](INDEX.md#4-architectural-decision-records-docsadr--78-active-adrs). |
| [`docs/agents/`](agents/) | Local `.scratch/` issue tracker conventions (`issue-tracker.md`, `triage-labels.md`) used by repository automation skills. |
| [`docs/security/dependency-license-audit.md`](security/dependency-license-audit.md) | Dependency license gate (`pnpm run dependency:licenses`) and supply-chain audit policy. |
| [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) & [`docs/third-party/`](third-party/) | Open-source attributions and clean-room adoption provenance. |
| [`docs/release/`](release/) | Versioned release notes (`0.1.2.md` – `0.5.4.md`) consumed by GitHub Release pipelines. |
| [`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md) | Engineering bootstrap, commands, coding conventions, and architectural invariants for contributors and coding agents. |

## Documentation Hygiene

- Keep every document evergreen and current-state only: edit outdated rules directly in place instead of appending revision logs.
- Update [`docs/INDEX.md`](INDEX.md) whenever adding, moving, renaming, or removing documentation files.
- Never hand-edit generated files (`shared/types.ts`, `docs/protocol/v1/*.json`, `docs/plugins/contract-bindings.md`).
