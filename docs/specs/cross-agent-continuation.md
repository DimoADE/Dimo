# Cross-Agent Continuation & Deterministic Handoff Specification

**Status:** Active  
**Related ADRs:** [ADR-0089](../adr/0089-conversation-binding-generations-and-history-segments.md), [ADR-0087](../adr/0087-dedicated-agent-engine-first-acp-fallback.md), [ADR-0091](../adr/0091-sqlite-single-authority-conversation-projection.md)  
**Primary Code:** `crates/conversations/src/turn/continuation.rs`, `crates/conversations/src/handoff.rs`

---

## 1. Core Invariants

1. **Conversation identity is stable across Agent switches.** Switching Agent or provider instance creates or reactivates a binding generation in `conversation_agent_bindings` without splitting the Conversation or mutating prior `conversation_timeline_rows`.
2. **Zero hidden LLM calls.** Cross-agent handoff packets are assembled deterministically from persisted SQLite history by `DeterministicHandoffService::build_execution_handoff` — identical packer for both UI preview and runtime execution.
3. **Owner & concurrency guards.**
   - Conversations owned by `workflow_step`, `delegation`, or a collaboration bot whose bound member Agent differs are rejected with `continuation_not_allowed`.
   - Switching is blocked while a Turn is in-flight or non-terminal async tasks are still running on the current binding.

---

## 2. Continuation Key & Resume Head

Each Agent binding generation computes a deterministic `continuation_key`:

- With an explicit provider instance: `"{agent_id}|{provider_instance_id}|{working_dir}"`
- With the local default instance: `"{agent_id}|{working_dir}"`

Within a Conversation, at most one active binding per `continuation_key` holds `is_resume_head = true`:

- **Returning to a known `continuation_key` (`Resume`)**: Reactivates that binding's native session rather than cold-starting, and computes a **delta gap** so the Agent only receives turns it has not yet seen.
- **Switching to an unseen `continuation_key` (`ColdStart`)**: Creates a new binding generation and delivers a bounded handoff packet of prior conversation context.

---

## 3. Delta Gap & Deterministic Packing

When `ContinuationPolicy::Portable` is active:

1. **Known set calculation**: For a resumed binding `B`, the already-known items are `known_segment_prefixes(B) ∪ delivered_item_ids(B)`. Only items outside this set enter the handoff delta.
2. **Budgeted deterministic packing**: `DeterministicHandoffService::build_execution_handoff` packs recent user/assistant turns, tool outcomes, and relevant diagnostics under a strict byte budget `min(64 KiB, 128 KiB - current_bytes)` and reports estimated `handoffTokens` for preview and boundary dividers.
3. **Nested marker stripping**: Inline handoff preambles delimited by `HANDOFF_MARKER` .. `HANDOFF_END` are stripped when building subsequent projections or future handoffs so repeated cross-agent switches never recursively nest prior handoff wrappers.

---

## 4. Durable Handoff Delivery State Machine (`conversation_handoffs`)

Every handoff delivery is tracked durably in `conversation_handoffs`:

```text
planned ──▶ sending ──▶ delivered
   │           ├──▶ uncertain   (crash / interrupted mid-flight)
   │           └──▶ cancelled   (user cancel before acceptance)
   └──▶ cancelled / refused
```

- **`PromptStarted` is not delivery proof.** Only a confirmed Agent prompt acceptance (`handoff::accept`) transitions a handoff to `delivered` and records its `delivered_item_ids`.
- **Startup recovery (`handoff::recover`)**: Stale `sending` records transition to `uncertain` (excluded from `delivered_item_ids` so subsequent resume retries the delta safely); stale `planned` records transition to `cancelled`.
- **Timeline boundary visibility**: Confirming an engine switch or fork emits a visible `agent_handoff` boundary marker recording source/target Agent and `handoffTokens`.
