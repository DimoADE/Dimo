use std::{str::FromStr, sync::Arc};

use db::{
    DBService,
    models::{
        execution_process::{ExecutionProcess, ExecutionProcessRunReason},
        project::Project,
        scratch::Scratch,
        session::Session,
        workspace::Workspace,
    },
};
use serde_json::json;
use sqlx::{Error as SqlxError, Sqlite, SqlitePool, decode::Decode, sqlite::SqliteOperation};
use tokio::sync::RwLock;
use utils::msg_store::MsgStore;
use uuid::Uuid;

#[path = "events/patches.rs"]
pub mod patches;
#[path = "events/streams.rs"]
mod streams;
#[path = "events/types.rs"]
pub mod types;

pub use patches::{execution_process_patch, project_patch, scratch_patch, workspace_patch};
pub use types::{EventError, EventPatch, EventPatchInner, HookTables, RecordTypes};

#[derive(Clone)]
pub struct EventService {
    msg_store: Arc<MsgStore>,
    db: DBService,
}

impl EventService {
    /// Creates a new EventService that will work with a DBService configured with hooks
    pub fn new(db: DBService, msg_store: Arc<MsgStore>) -> Self {
        Self { msg_store, db }
    }

    async fn push_workspace_update_for_session(
        pool: &SqlitePool,
        msg_store: Arc<MsgStore>,
        session_id: Uuid,
    ) -> Result<(), SqlxError> {
        if let Some(session) = Session::find_by_id(pool, session_id).await?
            && let Some(workspace_with_status) =
                Workspace::find_by_id_with_status(pool, session.workspace_id).await?
        {
            msg_store.push_patch(workspace_patch::replace(&workspace_with_status));
        }
        Ok(())
    }

    /// Creates the writer-only `after_connect` hook function using [`db::ReadPool`]
    /// and [`db::CommitVisibilityFence`] so update hooks never allocate a hidden
    /// secondary SQLite pool and never race ahead of WAL transaction commits.
    pub fn create_hook(
        msg_store: Arc<MsgStore>,
        entry_count: Arc<RwLock<usize>>,
        reader: db::ReadPool,
        commit_fence: db::CommitVisibilityFence,
    ) -> impl for<'a> Fn(
        &'a mut sqlx::sqlite::SqliteConnection,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>,
    > + Send
    + Sync
    + 'static {
        move |conn: &mut sqlx::sqlite::SqliteConnection| {
            let msg_store_for_hook = msg_store.clone();
            let entry_count_for_hook = entry_count.clone();
            let reader_for_hook = reader.clone();
            let commit_fence_for_hook = commit_fence.clone();
            Box::pin(async move {
                let mut handle = conn.lock_handle().await?;
                let runtime_handle = tokio::runtime::Handle::current();
                let pending_deletes: Arc<std::sync::Mutex<Vec<json_patch::Patch>>> =
                    Arc::new(std::sync::Mutex::new(Vec::new()));
                let pending_updates: Arc<
                    std::sync::Mutex<Vec<(HookTables, SqliteOperation, i64)>>,
                > = Arc::new(std::sync::Mutex::new(Vec::new()));

                handle.set_preupdate_hook({
                    let pending_deletes = pending_deletes.clone();
                    move |preupdate: sqlx::sqlite::PreupdateHookResult<'_>| {
                        if preupdate.operation != SqliteOperation::Delete {
                            return;
                        }

                        let patch = match preupdate.table {
                            "projects" => preupdate
                                .get_old_column_value(0)
                                .ok()
                                .and_then(|value| <Uuid as Decode<Sqlite>>::decode(value).ok())
                                .map(project_patch::remove),
                            "workspaces" => preupdate
                                .get_old_column_value(0)
                                .ok()
                                .and_then(|value| <Uuid as Decode<Sqlite>>::decode(value).ok())
                                .map(workspace_patch::remove),
                            "execution_processes" => preupdate
                                .get_old_column_value(0)
                                .ok()
                                .and_then(|value| <Uuid as Decode<Sqlite>>::decode(value).ok())
                                .map(execution_process_patch::remove),
                            "scratch" => {
                                // Composite key: need both id (column 0) and scratch_type (column 1)
                                preupdate
                                    .get_old_column_value(0)
                                    .ok()
                                    .and_then(|value| <Uuid as Decode<Sqlite>>::decode(value).ok())
                                    .zip(preupdate.get_old_column_value(1).ok().and_then(|value| {
                                        <String as Decode<Sqlite>>::decode(value).ok()
                                    }))
                                    .map(|(scratch_id, type_str)| {
                                        scratch_patch::remove(scratch_id, &type_str)
                                    })
                            }
                            _ => None,
                        };
                        if let Some(patch) = patch
                            && let Ok(mut pending) = pending_deletes.lock()
                        {
                            pending.push(patch);
                        }
                    }
                });

                handle.set_update_hook({
                    let pending_updates = pending_updates.clone();
                    move |hook: sqlx::sqlite::UpdateHookResult<'_>| {
                        if hook.operation == SqliteOperation::Delete {
                            // Deletions handled in preupdate hook for reliable data capture
                            return;
                        }
                        if let Ok(table) = HookTables::from_str(hook.table)
                            && let Ok(mut pending) = pending_updates.lock()
                        {
                            pending.push((table, hook.operation.clone(), hook.rowid));
                        }
                    }
                });

                handle.set_rollback_hook({
                    let pending_deletes = pending_deletes.clone();
                    let pending_updates = pending_updates.clone();
                    move || {
                        if let Ok(mut deletes) = pending_deletes.lock() {
                            deletes.clear();
                        }
                        if let Ok(mut updates) = pending_updates.lock() {
                            updates.clear();
                        }
                    }
                });

                handle.set_commit_hook(move || {
                    let deletes = pending_deletes
                        .lock()
                        .map(|mut pending| std::mem::take(&mut *pending))
                        .unwrap_or_default();
                    let updates = pending_updates
                        .lock()
                        .map(|mut pending| std::mem::take(&mut *pending))
                        .unwrap_or_default();
                    if deletes.is_empty() && updates.is_empty() {
                        return true;
                    }

                    let msg_store = msg_store_for_hook.clone();
                    let entry_count = entry_count_for_hook.clone();
                    let read_pool = reader_for_hook.as_pool().clone();
                    let commit_fence = commit_fence_for_hook.clone();

                    runtime_handle.spawn(async move {
                        // Wait until the single writer connection finishes publishing the WAL
                        // commit frame and returns to WritePool so ReadPool always observes
                        // committed inserts and non-stale updates.
                        commit_fence.wait_for_commit().await;

                        for patch in deletes {
                            msg_store.push_patch(patch);
                        }

                        for (table, operation, rowid) in updates {
                            let record_type: RecordTypes = match (table, operation.clone()) {
                                (HookTables::Projects, SqliteOperation::Delete)
                                | (HookTables::Workspaces, SqliteOperation::Delete)
                                | (HookTables::ExecutionProcesses, SqliteOperation::Delete)
                                | (HookTables::Scratch, SqliteOperation::Delete) => continue,
                                (HookTables::Projects, _) => {
                                    match Project::find_by_rowid(&read_pool, rowid).await {
                                        Ok(Some(project)) => RecordTypes::Project(project),
                                        Ok(None) => RecordTypes::DeletedProject {
                                            rowid,
                                            project_id: None,
                                        },
                                        Err(e) => {
                                            tracing::error!("Failed to fetch project: {:?}", e);
                                            continue;
                                        }
                                    }
                                }
                                (HookTables::Workspaces, _) => {
                                    match Workspace::find_by_rowid(&read_pool, rowid).await {
                                        Ok(Some(workspace)) => RecordTypes::Workspace(workspace),
                                        Ok(None) => RecordTypes::DeletedWorkspace { rowid },
                                        Err(e) => {
                                            tracing::error!(
                                                "Failed to fetch workspace: {:?}",
                                                e
                                            );
                                            continue;
                                        }
                                    }
                                }
                                (HookTables::ExecutionProcesses, _) => {
                                    match ExecutionProcess::find_by_rowid(&read_pool, rowid).await {
                                        Ok(Some(process)) => RecordTypes::ExecutionProcess(process),
                                        Ok(None) => RecordTypes::DeletedExecutionProcess {
                                            rowid,
                                            session_id: None,
                                            process_id: None,
                                        },
                                        Err(e) => {
                                            tracing::error!(
                                                "Failed to fetch execution_process: {:?}",
                                                e
                                            );
                                            continue;
                                        }
                                    }
                                }
                                (HookTables::Scratch, _) => {
                                    match Scratch::find_by_rowid(&read_pool, rowid).await {
                                        Ok(Some(scratch)) => RecordTypes::Scratch(scratch),
                                        Ok(None) => RecordTypes::DeletedScratch {
                                            rowid,
                                            scratch_id: None,
                                            scratch_type: None,
                                        },
                                        Err(e) => {
                                            tracing::error!("Failed to fetch scratch: {:?}", e);
                                            continue;
                                        }
                                    }
                                }
                            };

                            let db_op: &str = match operation {
                                SqliteOperation::Insert => "insert",
                                SqliteOperation::Delete => "delete",
                                SqliteOperation::Update => "update",
                                SqliteOperation::Unknown(_) => "unknown",
                            };

                            match &record_type {
                                RecordTypes::Project(project) => {
                                    let patch = project_patch::sync_visible(
                                        project,
                                        matches!(operation, SqliteOperation::Insert),
                                    );
                                    msg_store.push_patch(patch);
                                    continue;
                                }
                                RecordTypes::Scratch(scratch) => {
                                    let patch = match operation {
                                        SqliteOperation::Insert => scratch_patch::add(scratch),
                                        SqliteOperation::Update => scratch_patch::replace(scratch),
                                        _ => scratch_patch::replace(scratch),
                                    };
                                    msg_store.push_patch(patch);
                                    continue;
                                }
                                RecordTypes::DeletedScratch {
                                    scratch_id: Some(scratch_id),
                                    scratch_type: Some(scratch_type_str),
                                    ..
                                } => {
                                    let patch =
                                        scratch_patch::remove(*scratch_id, scratch_type_str);
                                    msg_store.push_patch(patch);
                                    continue;
                                }
                                RecordTypes::Workspace(workspace) => {
                                    if let Ok(Some(workspace_with_status)) =
                                        Workspace::find_by_id_with_status(&read_pool, workspace.id)
                                            .await
                                    {
                                        let patch = match operation {
                                            SqliteOperation::Insert => {
                                                workspace_patch::add(&workspace_with_status)
                                            }
                                            _ => workspace_patch::replace(&workspace_with_status),
                                        };
                                        msg_store.push_patch(patch);
                                    }
                                    continue;
                                }
                                RecordTypes::DeletedWorkspace { .. } => {
                                    continue;
                                }
                                RecordTypes::ExecutionProcess(process) => {
                                    let patch = match operation {
                                        SqliteOperation::Insert => {
                                            execution_process_patch::add(process)
                                        }
                                        SqliteOperation::Update => {
                                            execution_process_patch::replace(process)
                                        }
                                        _ => execution_process_patch::replace(process),
                                    };
                                    msg_store.push_patch(patch);

                                    let affects_workspace_status = matches!(
                                        process.run_reason,
                                        ExecutionProcessRunReason::SetupScript
                                            | ExecutionProcessRunReason::CleanupScript
                                    );
                                    if affects_workspace_status
                                        && let Err(err) =
                                            EventService::push_workspace_update_for_session(
                                                &read_pool,
                                                msg_store.clone(),
                                                process.session_id,
                                            )
                                            .await
                                    {
                                        tracing::error!(
                                            "Failed to push workspace update after execution process change: {:?}",
                                            err
                                        );
                                    }
                                    continue;
                                }
                                RecordTypes::DeletedExecutionProcess {
                                    process_id: Some(process_id),
                                    session_id,
                                    ..
                                } => {
                                    let patch = execution_process_patch::remove(*process_id);
                                    msg_store.push_patch(patch);

                                    if let Some(session_id) = session_id
                                        && let Err(err) =
                                            EventService::push_workspace_update_for_session(
                                                &read_pool,
                                                msg_store.clone(),
                                                *session_id,
                                            )
                                            .await
                                    {
                                        tracing::error!(
                                            "Failed to push workspace update after execution process removal: {:?}",
                                            err
                                        );
                                    }
                                    continue;
                                }
                                _ => {}
                            }

                            // Fallback: use the old entries format for other record types
                            let next_entry_count = {
                                let mut count = entry_count.write().await;
                                *count += 1;
                                *count
                            };

                            let event_patch: EventPatch = EventPatch {
                                op: "add".to_string(),
                                path: format!("/entries/{next_entry_count}"),
                                value: EventPatchInner {
                                    db_op: db_op.to_string(),
                                    record: record_type,
                                },
                            };

                            let patch = serde_json::from_value(json!([
                                serde_json::to_value(event_patch).unwrap()
                            ]))
                            .unwrap();

                            msg_store.push_patch(patch);
                        }
                    });

                    // Allow SQLite to commit the transaction.
                    true
                });

                Ok(())
            })
        }
    }

    pub fn msg_store(&self) -> &Arc<MsgStore> {
        &self.msg_store
    }
}
