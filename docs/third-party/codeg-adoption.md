# Codeg Adoption Record

This document records the upstream **Codeg** (`https://github.com/xintaofei/codeg`, Apache License 2.0) commits and files reviewed for clean-room behavioral adaptation in Dimo, along with the current Dimo crate/module mapping and Apache-2.0 attribution boundaries.

No Codeg source file is carried as a byte-identical copy; all adopted designs were reimplemented around Dimo's ports-and-adapters architecture, SQLite single-authority conversation projection, and `HostCommandRegistry` seam.

---

## 1. Built-In Browser (`v0.31.0`)

- **Repository**: `https://github.com/xintaofei/codeg`
- **Pinned commit**: `aace536fe9e38575a8973ed83435199ecc2700c6` (tag `v0.31.0`)
- **License**: Apache License 2.0
- **Upstream files reviewed**:
  - `src-tauri/src/browser/policy.rs`
  - `src-tauri/src/browser/eval.rs`
  - `src-tauri/src/browser/confirm.rs`
  - `src/browser-injected/eval-render.js`
  - `src/browser-injected/picker.js`
  - `src-tauri/src/browser/js/agent.bundle.js`
- **Dimo targets**: `crates/browser-host/`, `plugins/browser/` (`dimo.browser`), and `frontend/src/features/host-browser/HostBrowserPanel.tsx`.
- **Adaptations**: Paths and environment variables use Dimo conventions (`DIMO_POLICY_FILE`, Dimo data directories) while preserving grant, eval-consent, and URL scheme allow-list semantics.

---

## 2. Host, Transport, Artifacts, Delegation & Automation Parity

- **Repository**: `https://github.com/xintaofei/codeg`
- **Pinned commit**: `549add8d3ba07f31464c9cddde8ba7a7478eed14`
- **License**: Apache License 2.0

### 2.1 Application & Remote Transport Contracts

- **Upstream files reviewed**:
  - `src/lib/transport/types.ts`
  - `src/lib/transport/tauri-transport.ts`
  - `src/lib/transport/remote-desktop-transport.ts`
  - `src/lib/transport/web-event-stream.ts`
  - `src/lib/transport/web-transport.ts`
  - `src-tauri/src/bin/codeg_server.rs`
  - `src-tauri/src/web/auth.rs`
  - `src-tauri/src/web/router.rs`
  - `src-tauri/src/web/event_bridge.rs`
  - `src-tauri/src/web/ws.rs`
- **Dimo targets**: `frontend/src/lib/transport/`, `crates/server/`, `crates/application/`, and `crates/remote-protocol/`.
- **Adaptations**: Adopted transport-neutral RPC/event subscription separation, capability discovery, snapshot/replay catch-up, high-water live delivery, multiplexed WebSocket subscriptions, and static SPA hosting. Replaced arbitrary string dispatch and in-memory ring recovery with Dimo's closed `HostCommandRegistry`, hashed bearer/device tokens, versioned `remote-protocol` envelopes, persisted conversation sequence replay, explicit CORS allow-lists, and single-owner SQLite Host leases.

### 2.2 Office Preview & Artifact Preview Leases

- **Upstream files reviewed**:
  - `src-tauri/src/office_watch/mod.rs`
  - `src-tauri/src/commands/office_tools.rs`
  - `src-tauri/src/web/handlers/office_watch_proxy.rs`
- **Dimo targets**: `plugins/office/` (`dimo.office`), `crates/artifacts/` (`src/office.rs`, `src/adapters.rs`, `src/service.rs`), `crates/tool-runtime/`, and `crates/server/src/preview_proxy.rs`.
- **Adaptations**: Retained one-file/one-process reference counting, readiness probing, process limits, crash recovery, explicit close, and idle reaping behind `ArtifactToolProvider` and `ToolInstallationLock` (removing ambient `PATH` lookup and ad-hoc shell installers). `crates/server/src/preview_proxy.rs` accepts only registered `ArtifactPreviewLease` entries, stores only SHA-256 digests of short-lived capability tokens, pins upstreams to registered loopback ports, rejects host/traversal input, strips host credentials/cookies/origin headers, and serves opaque-origin preview iframes.

### 2.3 Delegation & MCP Companion Parity

- **Upstream files reviewed**:
  - `src-tauri/src/acp/delegation/{broker,companion,listener,parent_watcher,transport,types}.rs`
  - `src-tauri/src/acp/delegation/tool_schema.json`
  - `src-tauri/src/bin/codeg_mcp.rs`
- **Dimo targets**: `crates/delegation/`, `crates/delegation-proto/`, and `crates/dimo-mcp/`.
- **Adaptations**: Adopted asynchronous task IDs, batched status waits, first-terminal-wins setup races, per-parent cache isolation, bounded framing, parent teardown, feedback pull/commit, blocking questions, and read-only session info. Adapted `@Agent`/`codeg://agent` conventions to Dimo's `&Agent` and `dimo://agent` contract with open `AgentId`, Conversation UUIDs, token scope binding, and a 256 KiB result cap.

### 2.4 Automation Scheduling Parity

- **Upstream files reviewed**:
  - `src-tauri/src/models/automation.rs`
  - `src-tauri/src/automation/engine.rs`
  - `src-tauri/src/db/automation.rs`
- **Dimo targets**: `crates/automation/` and `crates/db/`.
- **Adaptations**: Reimplemented manual and cron triggers, pre-execution `next_run_at` advancement, run history, isolated worktrees, and startup recovery around Dimo's versioned `TurnLaunchSpec`, explicit IANA timezones, single-owner SQLite lease, transactional due claims, durable Conversation/Turn correlation, and four deterministic terminal states.

---

## 3. Agent Settings & Diagnostics Parity

- **Repository**: `https://github.com/xintaofei/codeg`
- **Pinned commit**: `fa230248d285c3f4fa541a737fc93f209820512e`
- **License**: Apache License 2.0
- **Upstream files reviewed**:
  - `src/components/settings/acp-agent-settings.tsx`
  - `src/components/settings/agent-diagnostics-dialog.tsx`
  - `src/components/settings/{pi,kimi-code,codebuddy,cursor}-config-panel.tsx`
  - `src/components/settings/{opencode-connect-dialog,opencode-plugins-modal}.tsx`
  - `src/components/settings/{model-provider-settings,codex-model-list-editor}.tsx`
  - `src/components/settings/{mcp-settings,custom-skills-settings}.tsx`
  - `src-tauri/src/acp/{registry,preflight,manager,codex_model_catalog}.rs`
  - `src-tauri/src/acp/{opencode_catalog,opencode_plugins}.rs`
  - `src-tauri/src/commands/{acp,mcp,custom_skills,model_provider}.rs`
  - `src-tauri/src/parsers/{opencode,kimi_code,grok,pi,cursor}.rs`
- **Dimo targets**: `crates/agents/`, `crates/services/`, `crates/db/`, `crates/server/`, and `frontend/src/pages/settings/`.
- **Adaptations**: Adopted the default built-in Agent catalog, version-pinned installation plans, redacted live install logs, dependency preflight, auth mode presentation, native config editors, Codex device auth and model catalogs, reusable Model Provider presets, OpenCode provider/plugin management, MCP/Skills settings, redacted environment overrides with compare-and-set revisions, and read-only environment reports (capability contract recorded in ADR-0037). Dimo retains its own open `AgentId`, `InstallationLock`, dedicated-engine-first runtime, optimistic native-file revisions, and secret redaction across Host boundaries.

---

## 4. Clean-Room Boundary & Mobile Exclusion

- No Codeg iOS/Android source, generated model, pairing flow, or wire schema was copied or adapted; TypeScript, Swift, and Kotlin fixtures are generated directly from Dimo's `crates/remote-protocol` crate.
- All adopted capabilities live in Dimo's own Rust crates, Electron desktop shell, React workbench, and official v4 plugins.

---

## 5. Verification & Apache-2.0 Obligations

```bash
node --test scripts/check-third-party-adoption.test.js
cargo test -p artifacts -p delegation-proto -p delegation -p dimo-mcp -p automation -p server -p agents
pnpm --filter ./frontend test
```

Dimo preserves the upstream license and attribution in root [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md). A complete copy of Apache License 2.0 is stored at [`docs/third-party/licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).
