# Pulse Event-Driven Automation Engine & Dual-Primitive Workflows

**Status:** Active  
**Related ADRs:** [ADR-0092](../adr/0092-pulse-event-driven-automation-and-dual-primitive-workflows.md), [ADR-0045](../adr/0045-workflows-orchestrate-conversation-turns.md), [ADR-0049](../adr/0049-workflow-source-artifacts-and-portable-automation-specs.md)  
**Primary Code:** `crates/pulse/`, `crates/workflows/`, `packages/pulse-sdk/`, `shared/hostCommands.ts` (`pulse_*`)

---

## 1. Architecture Overview

Pulse unifies external webhooks, custom SDK events, scheduled/SLA timers, and internal collaboration events onto one typed event bus (`PulseEngine`) running inside `HostRuntime`. Matched rules dispatch into five controlled target primitives or trigger immutable Dual-Primitive DAG Workflows.

```text
GitHub / Jira / Feishu / Custom SDK / TemporalSource (Cron + SLA)
                       │
            StandardWebhookGateway (HMAC + replay + payload cap)
                       │
                 EventEnvelope
                       │
     Guard Pipeline (actor.isSelf + hopCount + ChainRateBreaker + mandate origin)
                       │
     Rule Filter AST (JSON Pointer + bounded regex, dry_run_rule supported)
                       │
     PulseTargetSpec: Session | Bot | Group | User | Workflow (Dual-Primitive DAG)
```

---

## 2. Canonical `EventEnvelope` & Sources

Every event entering `PulseEngine` is normalized into an `EventEnvelope`:

| Field | Semantics |
| --- | --- |
| `eventType` | Namespaced event type string (built-in or custom-defined via `pulse_event_define`). |
| `source` | Normalizer origin: `GitHubSourceNormalizer`, `JiraSourceNormalizer`, `FeishuSourceNormalizer`, `CustomSdkEventNormalizer`, `Temporal`, or `Internal`. |
| `trustLevel` | Provenance trust tier distinguishing verified internal/user mandates from untrusted external webhooks. |
| `actor` | Originating identity including `isSelf` flag to identify Dimo-emitted actions. |
| `trace` | Causality chain carrying `rootEventId`, `parentEventId`, and `hopCount` (`derive_child_trace`). |
| `threadKey` | Stable correlation key for conversation/thread subscriptions and rate limiting. |
| `payload` | Structured JSON event body evaluated by JSON Pointer filter predicates. |

---

## 3. Security, Validation & Anti-Loop Guards

1. **Webhook Verification (`crates/pulse/src/webhook.rs`)**:
   - Verifies Standard Webhook headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) via HMAC (`verify_standard_webhook` / `sign_standard_webhook`).
   - Enforces replay window (`WEBHOOK_REPLAY_WINDOW_SECS`) and payload byte limit (`MAX_WEBHOOK_PAYLOAD_BYTES`).
2. **Filter Validation (`crates/pulse/src/validation.rs` & `filter.rs`)**:
   - Caps predicate count (`MAX_FILTER_CONDITIONS`) and compiled regex size (`REGEX_SIZE_LIMIT_BYTES`) to prevent ReDoS.
   - `dry_run_rule` evaluates rules against sample payloads with zero side effects.
3. **Three-Layer Anti-Loop Protection (`crates/pulse/src/guard.rs`)**:
   - **Self-suppression**: Events where `actor.isSelf == true` do not re-trigger the originating loop.
   - **Hop bound**: `trace.hopCount` is checked against `DEFAULT_MAX_HOP_COUNT`.
   - **Chain rate breaker**: Per-`threadKey` `ChainRateBreaker` halts runaway event cascades.
4. **Mandate Provenance Guard (`enforce_mandate_origin`)**:
   - Untrusted external events cannot directly create or activate high-privilege rules; agent-proposed rules from untrusted contexts stay in `Draft` or `Shadow` state until explicitly approved by the user.

---

## 4. Temporal Source & SLA Tracking (`crates/pulse/src/temporal.rs`)

`TemporalEvaluator` and `InactivitySlaTracker` emit standard `EventEnvelope` records for:

- Cron schedules (repeating automation triggers)
- One-shot delayed timers (`pulse_timer_schedule`)
- Thread/task inactivity SLA breaches

---

## 5. Five Dispatch Targets & Dual-Primitive Workflows

### Pulse Rule Targets (`PulseTargetSpec`)

- **`Session`**: Launches an isolated ephemeral workspace/conversation turn.
- **`Bot`**: Dispatches to a persistent Collaboration Space bot seat governed by `BotTurnMailbox`.
- **`Group`**: Posts into a multi-bot Collaboration Space room.
- **`User`**: Delivers an interactive user notification or approval gate.
- **`Workflow`**: Starts an immutable published `WorkflowDefinition` version.

### Dual-Primitive Workflow Nodes (`crates/workflows`)

Workflows (`*.dimo-workflow.json`) combine ephemeral and persistent execution primitives in one DAG:

- `SessionStepSpec` — ephemeral isolated Agent turn step
- `BotStepSpec` — persistent Collaboration Space bot step with `BotMailboxPolicy`
- `GroupStageStepSpec` — multi-bot group collaboration stage
- `UserGateStepSpec` — explicit human approval/decision gate
- `BoundedLoopStepSpec` — iteration with mandatory upper bound
- `WaitForEventStepSpec` — pauses run until a matching `EventEnvelope` arrives
- `OutboxActionStepSpec` — idempotent outbound side-effect action
- `ConditionBranchStepSpec` — deterministic conditional routing

Built-in graph presets: `DirectReflex`, `HybridPipeline`, `EventSaga`, `WindowAggregator`, `SuperagentRouter`. Incremental edits use `WorkflowGraphPatch`.

---

## 6. Host & MCP Control Surface

- **Host Commands (`shared/hostCommands.ts`)**: 20 `pulse_*` commands exposed uniformly over `HostCommandRegistry` and HTTP `/api/pulse/*` webhook ingress.
- **Unified `Dimo-superagent-mcp` Tools**: `pulse_catalog_inspect`, `pulse_event_define`, `pulse_event_emit`, `pulse_timer_schedule`, `pulse_rule_propose_or_save`, `pulse_rule_dry_run`, `pulse_thread_subscribe`, alongside `workflow_*` and delegation tools.
- **SDK (`packages/pulse-sdk`)**: TypeScript client, CLI, and Standard Webhook signature helpers targeting `dimo-server` (default port `17891`).
