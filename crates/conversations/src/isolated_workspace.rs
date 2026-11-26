//! Worktree-backed child workspaces, shared by workflow `write_isolated`
//! steps and collaboration members' WriteIsolated sessions.

use db::models::{
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use uuid::Uuid;

use crate::ConversationContext;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IsolatedWorkspaceError {
    #[error("write_isolated requires at least one repository")]
    NoRepositories,
    #[error("{0}")]
    Other(String),
}

impl IsolatedWorkspaceError {
    fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }
}

/// Create (or reuse) a worktree-backed child workspace of
/// `parent_workspace_id` on `branch`, covering every repo of the parent.
/// Shared by workflow `write_isolated` steps and collaboration members'
/// WriteIsolated sessions. Returns the workspace id and checkpoint evidence.
pub async fn create_isolated_workspace(
    context: &ConversationContext,
    parent_workspace_id: Uuid,
    isolated_workspace_id: Uuid,
    branch: String,
    title: String,
    purpose: &str,
) -> Result<(Uuid, serde_json::Value), IsolatedWorkspaceError> {
    let pool = &context.deployment.db().pool;
    let parent = Workspace::find_by_id(pool, parent_workspace_id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
        .ok_or_else(|| IsolatedWorkspaceError::other("workflow workspace not found"))?;
    let repos = WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, parent.id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    if repos.is_empty() {
        return Err(IsolatedWorkspaceError::NoRepositories);
    }
    let agent_working_dir = match repos.as_slice() {
        [repo] => Some(repo.repo.default_working_dir.as_deref().map_or_else(
            || repo.repo.name.clone(),
            |subdir| {
                std::path::PathBuf::from(&repo.repo.name)
                    .join(subdir)
                    .to_string_lossy()
                    .into_owned()
            },
        )),
        _ => None,
    };
    let workspace = if let Some(existing) = Workspace::find_by_id(pool, isolated_workspace_id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
    {
        existing
    } else {
        let task = Task::create(
            pool,
            &CreateTask {
                project_id: parent.project_id,
                title,
                description: None,
                status: Some(TaskStatus::Todo),
                parent_workspace_id: Some(parent.id),
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        let workspace = Workspace::create(
            pool,
            &CreateWorkspace {
                project_id: parent.project_id,
                parent_workspace_id: Some(parent.id),
                branch: branch.clone(),
                container_ref: None,
                use_worktree: true,
                agent_working_dir,
            },
            isolated_workspace_id,
            task.id,
        )
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        WorkspaceRepo::create_many(
            pool,
            workspace.id,
            &repos
                .iter()
                .map(|repo| CreateWorkspaceRepo {
                    repo_id: repo.repo.id,
                    target_branch: repo.target_branch.clone(),
                })
                .collect::<Vec<_>>(),
        )
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        workspace
    };

    if let Err(error) = context
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
    {
        return Err(IsolatedWorkspaceError::other(format!(
            "failed to create isolated {purpose} worktree {} (retained for review and retry): {error}",
            workspace.id
        )));
    }
    let materialized = Workspace::find_by_id(pool, workspace.id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
        .ok_or_else(|| IsolatedWorkspaceError::other("isolated workspace disappeared"))?;
    let mut checkpoints = Vec::new();
    for repo in &repos {
        let path = materialized
            .repo_path(&repo.repo)
            .ok_or_else(|| IsolatedWorkspaceError::other("isolated repo path is unavailable"))?;
        let head = context
            .deployment
            .git()
            .get_head_info(&path)
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        checkpoints.push(serde_json::json!({
            "repoId": repo.repo.id,
            "path": path,
            "targetBranch": repo.target_branch,
            "headCommit": head.oid,
        }));
    }
    Ok((
        workspace.id,
        serde_json::json!({
            "isolated": true,
            "workspaceId": workspace.id,
            "parentWorkspaceId": parent.id,
            "branch": branch,
            "checkpoint": checkpoints,
            "autoMerge": false,
        }),
    ))
}

/// Provisions member-session worktrees through the deployment's git/container.
pub struct DeploymentWorkspaceProvisioner<'a> {
    pub context: &'a ConversationContext,
}

#[async_trait::async_trait]
impl crate::collaboration::IsolatedWorkspaceProvisioner for DeploymentWorkspaceProvisioner<'_> {
    async fn provision(
        &self,
        plan: &crate::collaboration::MemberWritePlan,
        conversation_id: Uuid,
        isolated_workspace_id: Uuid,
    ) -> Result<Option<(Uuid, serde_json::Value)>, String> {
        match create_isolated_workspace(
            self.context,
            plan.workspace_id,
            isolated_workspace_id,
            format!("member/{}/{conversation_id}", plan.member_id),
            format!("Member session {conversation_id}"),
            "member session",
        )
        .await
        {
            Ok(created) => Ok(Some(created)),
            Err(IsolatedWorkspaceError::NoRepositories) => Ok(None),
            Err(IsolatedWorkspaceError::Other(message)) => Err(message),
        }
    }
}

/// Execution workspace for a turn (see `collaboration::execution_workspace_id`).
pub async fn execution_workspace_id(
    context: &ConversationContext,
    conversation_id: Uuid,
    session_workspace_id: Uuid,
) -> Result<Uuid, crate::collaboration::CollaborationError> {
    crate::collaboration::execution_workspace_id(
        &context.deployment.db().pool,
        conversation_id,
        session_workspace_id,
        &DeploymentWorkspaceProvisioner { context },
    )
    .await
}

/// Workspace strategy for `thread_launch`, `create_threads`, and `delegate_task`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceLaunchStrategy {
    /// Run directly in the target project's root directory.
    Root,
    /// Create a fresh isolated Git worktree for the target project.
    Worktree {
        base_ref: Option<String>,
        branch: Option<String>,
        start_from_origin: bool,
    },
    /// Attach to an already-existing Git worktree belonging to the target project.
    ExistingWorktree { worktree_path: std::path::PathBuf },
}

#[derive(Debug, Clone)]
pub struct PreparedProjectWorkspace {
    pub project_id: Uuid,
    pub workspace_id: Uuid,
    pub working_dir: std::path::PathBuf,
    pub branch: Option<String>,
    pub worktree_path: Option<std::path::PathBuf>,
    pub created_worktree: bool,
}

/// Verify that `candidate_path` resolves to an active Git worktree listed by
/// `git worktree list --porcelain` for `project_root`. Prevents arbitrary path
/// traversal outside the target project's git worktrees.
pub async fn validate_existing_worktree_path(
    project_root: &std::path::Path,
    candidate_path: &std::path::Path,
) -> Result<std::path::PathBuf, IsolatedWorkspaceError> {
    let canonical_candidate = tokio::fs::canonicalize(candidate_path)
        .await
        .map_err(|error| {
            IsolatedWorkspaceError::other(format!(
                "worktree_path '{}' is not accessible: {error}",
                candidate_path.display()
            ))
        })?;
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .await
        .map_err(|error| {
            IsolatedWorkspaceError::other(format!("failed to run git worktree list: {error}"))
        })?;
    if !output.status.success() {
        return Err(IsolatedWorkspaceError::other(format!(
            "git worktree list failed for '{}': {}",
            project_root.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let Some(raw) = line.strip_prefix("worktree ") else {
            continue;
        };
        if let Ok(listed) = tokio::fs::canonicalize(std::path::Path::new(raw.trim())).await
            && listed == canonical_candidate
        {
            return Ok(canonical_candidate);
        }
    }
    Err(IsolatedWorkspaceError::other(format!(
        "worktree_path '{}' is not a registered git worktree of project '{}'",
        candidate_path.display(),
        project_root.display()
    )))
}

/// Prepare a target project workspace according to `strategy`.
/// Handles root checkouts, fresh isolated worktrees (with optional `git fetch`
/// when `start_from_origin` is set), and verified existing worktrees.
pub async fn prepare_project_workspace(
    context: &ConversationContext,
    project_id: Uuid,
    parent_workspace_id: Option<Uuid>,
    strategy: WorkspaceLaunchStrategy,
    title: String,
) -> Result<PreparedProjectWorkspace, IsolatedWorkspaceError> {
    let pool = &context.deployment.db().pool;
    let project = db::models::project::Project::find_by_id(pool, project_id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
        .ok_or_else(|| IsolatedWorkspaceError::other(format!("Project {project_id} not found")))?;
    let project_repos =
        db::models::project_repo::ProjectRepo::find_repos_for_project(pool, project_id)
            .await
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    let root_path = std::path::PathBuf::from(&project.root_path);

    match strategy {
        WorkspaceLaunchStrategy::Root => {
            let workspace = ensure_root_workspace_for_project(
                pool,
                &project,
                &project_repos,
                parent_workspace_id,
                &title,
            )
            .await?;
            Ok(PreparedProjectWorkspace {
                project_id,
                workspace_id: workspace.id,
                working_dir: root_path,
                branch: (!workspace.branch.is_empty()).then_some(workspace.branch),
                worktree_path: None,
                created_worktree: false,
            })
        }
        WorkspaceLaunchStrategy::ExistingWorktree { worktree_path } => {
            let verified = validate_existing_worktree_path(&root_path, &worktree_path).await?;
            let detected_branch = detect_git_branch(&verified)
                .await
                .unwrap_or_else(|| "HEAD".to_string());
            let task = Task::create(
                pool,
                &CreateTask {
                    project_id,
                    title,
                    description: None,
                    status: Some(TaskStatus::Todo),
                    parent_workspace_id,
                    image_ids: None,
                },
                Uuid::new_v4(),
            )
            .await
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
            let workspace_id = Uuid::new_v4();
            let workspace = Workspace::create(
                pool,
                &CreateWorkspace {
                    project_id,
                    parent_workspace_id,
                    branch: detected_branch.clone(),
                    container_ref: Some(verified.to_string_lossy().into_owned()),
                    use_worktree: true,
                    agent_working_dir: project.default_agent_working_dir.clone(),
                },
                workspace_id,
                task.id,
            )
            .await
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
            if !project_repos.is_empty() {
                let target_branch = project
                    .default_main_branch
                    .clone()
                    .unwrap_or_else(|| "main".to_string());
                let create_repos: Vec<CreateWorkspaceRepo> = project_repos
                    .iter()
                    .map(|repo| CreateWorkspaceRepo {
                        repo_id: repo.id,
                        target_branch: target_branch.clone(),
                    })
                    .collect();
                WorkspaceRepo::create_many(pool, workspace.id, &create_repos)
                    .await
                    .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
            }
            Ok(PreparedProjectWorkspace {
                project_id,
                workspace_id: workspace.id,
                working_dir: verified.clone(),
                branch: Some(detected_branch),
                worktree_path: Some(verified),
                created_worktree: false,
            })
        }
        WorkspaceLaunchStrategy::Worktree {
            base_ref,
            branch,
            start_from_origin,
        } => {
            if project_repos.is_empty() {
                return Err(IsolatedWorkspaceError::NoRepositories);
            }
            if start_from_origin {
                for repo in &project_repos {
                    let _ = tokio::process::Command::new("git")
                        .arg("-C")
                        .arg(&repo.path)
                        .args(["fetch", "--quiet", "origin"])
                        .output()
                        .await;
                }
            }
            let workspace_id = Uuid::new_v4();
            let short_id = &workspace_id.simple().to_string()[..8];
            let effective_branch = branch
                .as_deref()
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("dimo/orch-{short_id}"));
            let default_target = base_ref
                .as_deref()
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .map(str::to_string)
                .or_else(|| project.default_main_branch.clone())
                .unwrap_or_else(|| "main".to_string());
            let agent_working_dir = match project_repos.as_slice() {
                [repo] => Some(repo.default_working_dir.as_deref().map_or_else(
                    || repo.name.clone(),
                    |subdir| {
                        std::path::PathBuf::from(&repo.name)
                            .join(subdir)
                            .to_string_lossy()
                            .into_owned()
                    },
                )),
                _ => None,
            };
            let task = Task::create(
                pool,
                &CreateTask {
                    project_id,
                    title,
                    description: None,
                    status: Some(TaskStatus::Todo),
                    parent_workspace_id,
                    image_ids: None,
                },
                Uuid::new_v4(),
            )
            .await
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
            let workspace = Workspace::create(
                pool,
                &CreateWorkspace {
                    project_id,
                    parent_workspace_id,
                    branch: effective_branch.clone(),
                    container_ref: None,
                    use_worktree: true,
                    agent_working_dir,
                },
                workspace_id,
                task.id,
            )
            .await
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
            let create_repos: Vec<CreateWorkspaceRepo> = project_repos
                .iter()
                .map(|repo| CreateWorkspaceRepo {
                    repo_id: repo.id,
                    target_branch: default_target.clone(),
                })
                .collect();
            WorkspaceRepo::create_many(pool, workspace.id, &create_repos)
                .await
                .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
            if let Err(error) = context
                .deployment
                .container()
                .ensure_container_exists(&workspace)
                .await
            {
                let _ = rollback_prepared_workspace(context, workspace.id).await;
                return Err(IsolatedWorkspaceError::other(format!(
                    "failed to prepare worktree for project {project_id}: {error}"
                )));
            }
            let materialized = Workspace::find_by_id(pool, workspace.id)
                .await
                .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
                .ok_or_else(|| IsolatedWorkspaceError::other("prepared workspace disappeared"))?;
            let resolved_dir = materialized
                .container_ref
                .as_deref()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| root_path.clone());
            let working_dir = if project_repos.len() == 1 {
                materialized
                    .repo_path(&project_repos[0])
                    .unwrap_or_else(|| resolved_dir.clone())
            } else {
                resolved_dir.clone()
            };
            let _ = Workspace::mark_setup_completed(pool, workspace.id).await;
            Ok(PreparedProjectWorkspace {
                project_id,
                workspace_id: workspace.id,
                working_dir: working_dir.clone(),
                branch: Some(effective_branch),
                worktree_path: Some(working_dir),
                created_worktree: true,
            })
        }
    }
}

/// Best-effort rollback for a worktree workspace whose preparation was cancelled
/// or failed before execution started.
pub async fn rollback_prepared_workspace(
    context: &ConversationContext,
    workspace_id: Uuid,
) -> Result<(), IsolatedWorkspaceError> {
    let pool = &context.deployment.db().pool;
    let Some(workspace) = Workspace::find_by_id(pool, workspace_id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
    else {
        return Ok(());
    };
    if workspace.use_worktree
        && let Some(container_ref) = workspace.container_ref.as_deref()
    {
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace_id)
            .await
            .unwrap_or_default();
        for repo in repos {
            let repo_wt = std::path::Path::new(container_ref).join(&repo.name);
            let target = if repo_wt.exists() {
                repo_wt
            } else {
                std::path::PathBuf::from(container_ref)
            };
            let _ = tokio::process::Command::new("git")
                .arg("-C")
                .arg(&repo.path)
                .args(["worktree", "remove", "--force"])
                .arg(&target)
                .output()
                .await;
        }
    }
    Ok(())
}

async fn ensure_root_workspace_for_project(
    pool: &sqlx::SqlitePool,
    project: &db::models::project::Project,
    project_repos: &[db::models::repo::Repo],
    parent_workspace_id: Option<Uuid>,
    title: &str,
) -> Result<Workspace, IsolatedWorkspaceError> {
    let existing = Workspace::fetch_by_project_id(pool, project.id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    if let Some(root_ws) = existing
        .into_iter()
        .find(|ws| !ws.use_worktree && !ws.archived)
    {
        return Ok(root_ws);
    }
    let task = Task::create(
        pool,
        &CreateTask {
            project_id: project.id,
            title: title.to_string(),
            description: None,
            status: Some(TaskStatus::Todo),
            parent_workspace_id,
            image_ids: None,
        },
        Uuid::new_v4(),
    )
    .await
    .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    let branch = project
        .default_main_branch
        .clone()
        .unwrap_or_else(|| "main".to_string());
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id: project.id,
            parent_workspace_id,
            branch: branch.clone(),
            container_ref: Some(project.root_path.clone()),
            use_worktree: false,
            agent_working_dir: project.default_agent_working_dir.clone(),
        },
        Uuid::new_v4(),
        task.id,
    )
    .await
    .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    if !project_repos.is_empty() {
        let create_repos: Vec<CreateWorkspaceRepo> = project_repos
            .iter()
            .map(|repo| CreateWorkspaceRepo {
                repo_id: repo.id,
                target_branch: branch.clone(),
            })
            .collect();
        WorkspaceRepo::create_many(pool, workspace.id, &create_repos)
            .await
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    }
    Ok(workspace)
}

/// Ensure a real, FK-valid scratch project + root workspace exists for
/// projectless (`scratch: true`) threads and fallback delegations so
/// `sessions.workspace_id` (`BLOB NOT NULL REFERENCES workspaces(id)`) is
/// always valid and `working_dir` points to a real directory on disk.
pub async fn ensure_orchestration_scratch_workspace(
    pool: &sqlx::SqlitePool,
) -> Result<PreparedProjectWorkspace, IsolatedWorkspaceError> {
    let scratch_dir = utils::path::dimo_scratch_subdir("orchestration")
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    let root_str = scratch_dir.to_string_lossy().into_owned();
    let project = match db::models::project::Project::find_any_by_root_path(pool, &root_str)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
    {
        Some(existing) => existing,
        None => {
            let project_id = Uuid::new_v4();
            db::models::project::Project::create(
                pool,
                &db::models::project::CreateProject {
                    name: "Dimo Scratch".to_string(),
                    root_path: root_str.clone(),
                    parent_project_id: None,
                    repositories: Vec::new(),
                },
                project_id,
            )
            .await
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
        }
    };
    let project_repos =
        db::models::project_repo::ProjectRepo::find_repos_for_project(pool, project.id)
            .await
            .unwrap_or_default();
    let workspace =
        ensure_root_workspace_for_project(pool, &project, &project_repos, None, "Scratch").await?;
    Ok(PreparedProjectWorkspace {
        project_id: project.id,
        workspace_id: workspace.id,
        working_dir: scratch_dir,
        branch: (!workspace.branch.is_empty()).then_some(workspace.branch),
        worktree_path: None,
        created_worktree: false,
    })
}

async fn detect_git_branch(path: &std::path::Path) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}
