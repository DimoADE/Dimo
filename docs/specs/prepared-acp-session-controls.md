# Spec: Prepared ACP Session Controls

**Status:** Implemented
**Scope:** ACP secondary compatibility channel ([ADR-0087](../adr/0087-dedicated-agent-engine-first-acp-fallback.md), [Agent Driver Engine Specification](agent-driver-engine.md))

## Decision

This specification governs session modes and configuration controls on the **ACP secondary compatibility channel** (long-tail agents and ACP Registry entries executed through `AcpClientBridge`). Dedicated native Agent engines (`ClaudeNativeDriver`, `CodexNativeDriver`, and other `EngineRegistry` drivers) derive session controls directly from `NativeEngineDriver::capabilities()` as defined in [`agent-driver-engine.md`](agent-driver-engine.md).

For ACP sessions, the concrete ACP Session is the only authority for a Conversation's modes and configuration options. Dimo creates that Session as soon as the create form has an Agent and an existing Workspace, renders the `session/new` response, and persists the Conversation with the same UUID. It does not copy the values to another Session and does not reconstruct them from profiles, probes, static catalogs, or browser storage.

## Lifecycle

1. The form allocates the future Conversation UUID.
2. `agent_prepare_session` resolves the verified local CLI/ACP paths and opens the real ACP Session for the selected Workspace.
3. The form renders the returned modes and `configOptions` verbatim.
4. A selection calls `session/set_mode` or `session/set_config_option` on that same Session. The full response replaces the displayed controls so dynamic dependencies (for example OpenCode model -> effort) remain authoritative.
5. Creating the Conversation persists the prepared UUID and commits ownership of the Session. Cancelling the form closes/discards the draft Session when supported.
6. When the Conversation service adopts the Session, the current controls are re-emitted into its event log for recovery and rendering.

## Protocol rules

- When non-empty `configOptions` are advertised, Dimo ignores legacy modes as required by ACP instead of merging two representations.
- Select values retain their raw IDs. Boolean options remain JSON booleans on the wire and render as switches.
- Dimo advertises stable boolean config-option support in the ACP client initialization capabilities.
- The local CLI and ACP adapter selected by Settings are mandatory; launch never silently falls back to a runtime bundled inside an adapter package.

## Acceptance criteria

- Opening ACP selectors never reads static capability catalogs or browser storage.
- The Session shown in the form and the Session used by the Conversation have the same UUID and external ACP Session ID.
- Model, effort, permission, mode, and Fast options are exactly those returned by the installed Agent/adapter pair.
- Model-dependent choices update after each ACP set-config response.
- A failed preparation cannot be submitted and does not leave an owned draft Session behind.
- Installing or updating an Agent invalidates runtime availability only; it does not start a second session-control discovery process.

## Scope boundary

This contract applies exclusively to the ACP compatibility channel. Dedicated native engines supply their session control surface through `NativeEngineDriver::capabilities()` (`EngineCapabilities`) under [`agent-driver-engine.md`](agent-driver-engine.md). Non-session provider and default-model settings remain isolated from both the create-session form and Conversation composer so there is never a competing session-control truth source.
