CREATE TABLE IF NOT EXISTS conversation_delegations (
    run_id                  TEXT PRIMARY KEY NOT NULL,
    parent_conversation_id  BLOB NOT NULL,
    child_conversation_id   BLOB NOT NULL UNIQUE,
    parent_tool_call_id     TEXT NOT NULL DEFAULT '',
    target_project_id       BLOB,
    target_workspace_id     BLOB,
    target_environment_id   TEXT,
    agent_id                TEXT NOT NULL,
    provider_instance_id    TEXT,
    model                   TEXT,
    role                    TEXT,
    task_preview            TEXT NOT NULL DEFAULT '',
    isolation               TEXT NOT NULL DEFAULT 'shared',
    mode                    TEXT NOT NULL DEFAULT 'async',
    completion_wake         TEXT NOT NULL DEFAULT 'always',
    max_runtime_mode        INTEGER NOT NULL DEFAULT 0,
    max_interaction_mode    INTEGER NOT NULL DEFAULT 1,
    status                  TEXT NOT NULL DEFAULT 'preparing',
    preparation_stage       TEXT,
    worktree_path           TEXT,
    branch                  TEXT,
    result_summary          TEXT,
    error_code              TEXT,
    error_message           TEXT,
    deadline_at             TEXT,
    delivered_at            TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    finished_at             TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversation_delegations_parent_status
    ON conversation_delegations (parent_conversation_id, status);

CREATE INDEX IF NOT EXISTS idx_conversation_delegations_child
    ON conversation_delegations (child_conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversation_delegations_undelivered
    ON conversation_delegations (parent_conversation_id, delivered_at)
    WHERE delivered_at IS NULL AND finished_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_delegations_deadline
    ON conversation_delegations (deadline_at)
    WHERE deadline_at IS NOT NULL AND finished_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_idempotency_receipts (
    scope_key       TEXT PRIMARY KEY NOT NULL,
    tool_name       TEXT NOT NULL,
    response_json   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
