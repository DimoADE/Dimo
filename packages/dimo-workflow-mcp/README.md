# `dimo-workflow-mcp` (Workflow MCP Server Bundle)

Host-family Node.js MCP server bundle (`dist/mcp/workflow-control.mjs`) that adapts Agent workflow tool calls onto a running **Dimo Host** (`electron/` Desktop with `dimo-server --desktop`, or standalone `dimo-server`).

> Looking for the official Dimo v4 plugin package (which provides the `dimo-workflow-creator` Skill and the `*.dimo-workflow.json` Workflow Studio editor)? See [`plugins/workflow-creator/`](../../plugins/workflow-creator/).

## Architecture

- **Host-family launcher (`crates/dimo-workflow-mcp`)**: Embeds `packages/dimo-workflow-mcp/dist/mcp/workflow-control.mjs` and multiplexes stdio JSON-RPC (`2026-07-28` + backward-compatible MCP revisions) between the Agent and this Node controller.
- **Native + Delegated Tool Surface**:
  - `crates/dimo-workflow-mcp` natively handles the Dual-Primitive `workflow_graph_patch` tool (`session` vs `bot` steps, `bounded_loop`, `wait_for_event`, `group_stage`, `user_gate`, `outbox_action`, and presets).
  - `dist/mcp/workflow-control.mjs` proxies workflow authoring, publication, run inspection, checkpointed reruns, pause/resume, and approval tools (`workflow_source_read`, `workflow_source_write`, `workflow_validate`, `workflow_publish`, `workflow_catalog`, `workflow_run_inspect`, `workflow_start`, `workflow_debug_source`, `workflow_debug_from_step`, `workflow_pause_run`, `workflow_resume_run`, `workflow_cancel_run`, `workflow_pause_step`, `workflow_continue_step`, `workflow_accept_candidate`, `workflow_review_step`, `workflow_decide_approval`) to the running Dimo Host.
- **Runtime & Auth**: Requires a running Dimo Host. The Host launches `dimo-workflow-mcp` with its managed Node.js runtime and injects an ephemeral loopback bearer token; no token is persisted inside this package. Traffic stays on loopback between the MCP process and Dimo Host.

## Debugging & Revision Semantics

- `*.dimo-workflow.json` is the authoring source of truth; saves require the expected artifact revision and reject stale overwrites.
- Publishing creates an immutable `WorkflowDefinition` version; existing Automations stay pinned to their selected version until explicitly updated.
- Pausing a node or DAG stops active Turns without marking the Run failed; continuing appends a new immutable Turn in the same node Conversation.
- Source debug runs (`workflow_debug_source`) execute against an unpublished durable snapshot without creating catalog versions; derived debug runs (`workflow_debug_from_step`) reuse checkpoint-verified completed ancestors.

## Development & Verification

```bash
pnpm install
pnpm build        # Rebuild dist/mcp/workflow-control.mjs via dimo-plugin build
pnpm test         # Run package test suite
pnpm test:plugin  # Run node --test test/plugin.test.mjs
pnpm test:mcp     # Run node --test test-mcp/mcp-server.test.mjs
```

### Live Host Testing

With Dimo Desktop or `dimo-server` running and the `dimo.workflow-creator` plugin enabled:

```bash
pnpm test:live status <run-id>
pnpm test:live debug-source <workspace-id> <step-id>
```

Set `DIMO_WORKSPACE_ROOT` when resolving project-relative `*.dimo-workflow.json` paths against a specific workspace directory.

## Troubleshooting

- **Dimo Host unavailable**: Ensure Dimo Desktop or `dimo-server` is running, then start a new Agent session so the Host injects a fresh MCP binding and bearer token.
- **Save conflict**: The `*.dimo-workflow.json` file changed outside the current revision; re-read with `workflow_source_read`, reconcile changes, and write with the latest revision.
- **Automation still running an older version**: Automations pin an exact published version; call `workflow_publish` and update the Automation target version.
