use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use agents::{
    AgentContentBlock, AgentId, AgentSessionId, EnsureAgentSessionInput, SendAgentPromptInput,
};
use application::{ApplicationError, DomainCommand};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    image::TaskImage,
    merge::{Merge, MergeStatus, PrMerge, PullRequestInfo},
    project_repo::ProjectRepo,
    repo::{Repo, RepoError},
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskStatus, TaskWithAttemptStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use executors::profile::ExecutorProfileId;
use git::{GitCliError, GitRemote, GitServiceError};
use git2::BranchType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    container_actions,
    git_host::{CreatePrRequest, GitHostError, GitHostProvider, GitHostService, ProviderKind},
};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIdArgs {
    #[serde(alias = "workspace_id")]
    workspace_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePrArgs {
    #[serde(alias = "workspace_id")]
    workspace_id: Uuid,
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default, alias = "target_branch")]
    target_branch: Option<String>,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(alias = "repo_id")]
    repo_id: Uuid,
    #[serde(default, alias = "auto_generate_description")]
    auto_generate_description: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceFromPrRequest {
    #[serde(alias = "repo_id")]
    repo_id: Uuid,
    #[serde(alias = "pr_number")]
    pr_number: i64,
    #[serde(alias = "pr_title")]
    pr_title: String,
    #[serde(alias = "pr_url")]
    pr_url: String,
    #[serde(alias = "head_branch")]
    head_branch: String,
    #[serde(alias = "base_branch")]
    base_branch: String,
    #[serde(alias = "run_setup")]
    run_setup: bool,
    #[serde(default, alias = "remote_name")]
    remote_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAndStartTaskRequest {
    task: CreateTask,
    #[serde(alias = "executor_profile_id")]
    executor_profile_id: ExecutorProfileId,
    repos: Vec<WorkspaceRepoSpec>,
    #[serde(default = "default_use_worktree", alias = "use_worktree")]
    use_worktree: bool,
}

fn default_use_worktree() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRepoSpec {
    #[serde(alias = "repo_id")]
    repo_id: Uuid,
    #[serde(alias = "target_branch")]
    target_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BranchStatus {
    pub commits_behind: Option<usize>,
    pub commits_ahead: Option<usize>,
    pub has_uncommitted_changes: Option<bool>,
    pub head_oid: Option<String>,
    pub uncommitted_count: Option<usize>,
    pub untracked_count: Option<usize>,
    pub target_branch_name: String,
    pub remote_commits_behind: Option<usize>,
    pub remote_commits_ahead: Option<usize>,
    pub merges: Vec<Merge>,
    pub is_rebase_in_progress: bool,
    pub conflict_op: Option<git::ConflictOp>,
    pub conflicted_files: Vec<String>,
    pub is_target_remote: bool,
}

#[derive(Debug, Clone, Serialize)]
struct RepoBranchStatus {
    pub repo_id: Uuid,
    pub repo_name: String,
    #[serde(flatten)]
    pub status: BranchStatus,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RunScriptError {
    NoScriptConfigured,
    ProcessAlreadyRunning,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PrError {
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
    GitCliNotLoggedIn,
    GitCliNotInstalled,
    TargetBranchNotFound { branch: String },
    UnsupportedProvider,
}

#[derive(Debug, Serialize)]
struct CreateWorkspaceFromPrResponse {
    pub workspace: Workspace,
    pub task: Task,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CreateFromPrError {
    PrNotFound,
    BranchFetchFailed { message: String },
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
    RepoNotInProject,
}

fn run_script_error(error: RunScriptError) -> ApplicationError {
    let base = match &error {
        RunScriptError::ProcessAlreadyRunning => {
            ApplicationError::conflict("A process is already running in this workspace")
        }
        RunScriptError::NoScriptConfigured => {
            ApplicationError::bad_request("No script configured for this workspace")
        }
    };
    match serde_json::to_value(&error) {
        Ok(details) => base.with_detail(details),
        Err(_) => base,
    }
}

fn pr_error(error: PrError) -> ApplicationError {
    let message = match &error {
        PrError::CliNotInstalled { provider } => {
            format!("CLI for {provider:?} is not installed")
        }
        PrError::CliNotLoggedIn { provider } => {
            format!("CLI for {provider:?} is not logged in")
        }
        PrError::GitCliNotLoggedIn => "Git CLI is not authenticated".to_string(),
        PrError::GitCliNotInstalled => "Git CLI is not installed".to_string(),
        PrError::TargetBranchNotFound { branch } => {
            format!("Target branch '{branch}' was not found on the remote")
        }
        PrError::UnsupportedProvider => "Unsupported Git hosting provider".to_string(),
    };
    let base = ApplicationError::bad_request(message);
    match serde_json::to_value(&error) {
        Ok(details) => base.with_detail(details),
        Err(_) => base,
    }
}

fn create_from_pr_error(error: CreateFromPrError) -> ApplicationError {
    let message = match &error {
        CreateFromPrError::PrNotFound => "Pull request not found".to_string(),
        CreateFromPrError::BranchFetchFailed { message } => message.clone(),
        CreateFromPrError::CliNotInstalled { provider } => {
            format!("CLI for {provider:?} is not installed")
        }
        CreateFromPrError::AuthFailed { message } => message.clone(),
        CreateFromPrError::UnsupportedProvider => "Unsupported Git hosting provider".to_string(),
        CreateFromPrError::RepoNotInProject => {
            "Repository is not associated with any project".to_string()
        }
    };
    let base = ApplicationError::bad_request(message);
    match serde_json::to_value(&error) {
        Ok(details) => base.with_detail(details),
        Err(_) => base,
    }
}

impl ServerApplicationDomains {
    pub(crate) async fn workspace_branch_status_all(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspaceIdArgs = parse(args)?;
        let mut workspace = self.require_workspace(args.workspace_id).await?;
        let repositories = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let workspace_repos = WorkspaceRepo::find_by_workspace_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|row| (row.repo_id, row.target_branch.clone()))
            .collect();
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        workspace.container_ref = Some(container_ref.clone());
        let workspace_dir = PathBuf::from(&container_ref);
        let all_merges = Merge::find_by_workspace_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let mut merges_by_repo: HashMap<Uuid, Vec<Merge>> = HashMap::new();
        for merge in all_merges {
            let repo_id = match &merge {
                Merge::Direct(direct) => direct.repo_id,
                Merge::Pr(pr) => pr.repo_id,
            };
            merges_by_repo.entry(repo_id).or_default().push(merge);
        }

        let mut results = Vec::with_capacity(repositories.len());
        for repo in repositories {
            let Some(target_branch) = target_branches.get(&repo.id).cloned() else {
                continue;
            };
            let repo_merges = merges_by_repo.get(&repo.id).cloned().unwrap_or_default();
            let worktree_path = workspace
                .repo_path(&repo)
                .unwrap_or_else(|| workspace_dir.clone());
            let git = self.deployment.git().clone();
            let workspace_clone = workspace.clone();
            let repo_clone = repo.clone();
            let status = tokio::task::spawn_blocking(move || {
                branch_status_for_repo(
                    &git,
                    &workspace_clone,
                    &repo_clone,
                    &worktree_path,
                    &target_branch,
                    repo_merges,
                )
            })
            .await
            .map_err(internal_error)??;
            results.push(RepoBranchStatus {
                repo_id: repo.id,
                repo_name: repo.name,
                status,
            });
        }
        serialize(results)
    }

    pub(crate) async fn run_workspace_script(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspaceIdArgs = parse(args)?;
        let mut workspace = self.require_workspace(args.workspace_id).await?;
        let reason = match command {
            DomainCommand::WorkspaceRunSetupScript => ExecutionProcessRunReason::SetupScript,
            DomainCommand::WorkspaceRunCleanupScript => ExecutionProcessRunReason::CleanupScript,
            DomainCommand::WorkspaceRunArchiveScript => ExecutionProcessRunReason::ArchiveScript,
            _ => {
                return Err(ApplicationError::internal(
                    "workspace script command is not a script runner",
                ));
            }
        };
        if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
            &self.pool,
            workspace.id,
        )
        .await
        .map_err(internal_error)?
        {
            return Err(run_script_error(RunScriptError::ProcessAlreadyRunning));
        }
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        workspace.container_ref = Some(container_ref);
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let executor_action = match command {
            DomainCommand::WorkspaceRunSetupScript => {
                container_actions::setup_actions_for_repos(&repos)
            }
            DomainCommand::WorkspaceRunCleanupScript => {
                container_actions::cleanup_actions_for_repos(&repos)
            }
            DomainCommand::WorkspaceRunArchiveScript => {
                container_actions::archive_actions_for_repos(&repos)
            }
            _ => None,
        };
        let Some(executor_action) = executor_action else {
            return Err(run_script_error(RunScriptError::NoScriptConfigured));
        };
        let session = ensure_workspace_session(&self.pool, workspace.id).await?;
        let process = self
            .deployment
            .container()
            .start_execution(&workspace, &session, &executor_action, &reason)
            .await
            .map_err(internal_error)?;
        serialize(process)
    }

    pub(crate) async fn create_workspace_pr_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: CreatePrArgs = parse(args)?;
        let mut workspace = self.require_workspace(args.workspace_id).await?;
        let workspace_repo =
            WorkspaceRepo::find_by_workspace_and_repo_id(&self.pool, workspace.id, args.repo_id)
                .await
                .map_err(internal_error)?
                .ok_or(RepoError::NotFound)
                .map_err(internal_error)?;
        let repo = Repo::find_by_id(&self.pool, workspace_repo.repo_id)
            .await
            .map_err(internal_error)?
            .ok_or(RepoError::NotFound)
            .map_err(internal_error)?;
        let target = args
            .target_branch
            .clone()
            .unwrap_or_else(|| workspace_repo.target_branch.clone());
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        workspace.container_ref = Some(container_ref.clone());
        let workspace_path = PathBuf::from(&container_ref);
        let worktree_path = workspace
            .repo_path(&repo)
            .unwrap_or_else(|| workspace_path.clone());
        let git = self.deployment.git().clone();
        let repo_path_for_git = repo.path.clone();
        let worktree_for_git = worktree_path.clone();
        let workspace_branch = workspace.branch.clone();
        let target_for_git = target.clone();
        let (push_remote, target_remote, base_branch) = tokio::task::spawn_blocking(move || {
            let push_remote = git
                .resolve_remote_for_branch(&repo_path_for_git, &workspace_branch)
                .map_err(internal_error)?;
            let (target_remote, base_branch) =
                match git.get_remote_from_branch_name(&repo_path_for_git, &target_for_git) {
                    Ok(remote) => {
                        let branch = target_for_git
                            .strip_prefix(&format!("{}/", remote.name))
                            .unwrap_or(&target_for_git);
                        (remote, branch.to_string())
                    }
                    Err(_) => (push_remote.clone(), target_for_git.clone()),
                };
            match git.check_remote_branch_exists(
                &repo_path_for_git,
                &target_remote.url,
                &base_branch,
            ) {
                Ok(false) => {
                    return Err(pr_error(PrError::TargetBranchNotFound {
                        branch: target_for_git,
                    }));
                }
                Err(GitServiceError::GitCLI(GitCliError::AuthFailed(_))) => {
                    return Err(pr_error(PrError::GitCliNotLoggedIn));
                }
                Err(GitServiceError::GitCLI(GitCliError::NotAvailable)) => {
                    return Err(pr_error(PrError::GitCliNotInstalled));
                }
                Err(error) => return Err(internal_error(error)),
                Ok(true) => {}
            }
            if let Err(error) = git.push_to_remote(&worktree_for_git, &workspace_branch, false) {
                return Err(match error {
                    GitServiceError::GitCLI(GitCliError::AuthFailed(_)) => {
                        pr_error(PrError::GitCliNotLoggedIn)
                    }
                    GitServiceError::GitCLI(GitCliError::NotAvailable) => {
                        pr_error(PrError::GitCliNotInstalled)
                    }
                    other => internal_error(other),
                });
            }
            Ok((push_remote, target_remote, base_branch))
        })
        .await
        .map_err(internal_error)??;
        let git_host = match GitHostService::from_url(&target_remote.url) {
            Ok(host) => host,
            Err(GitHostError::UnsupportedProvider) => {
                return Err(pr_error(PrError::UnsupportedProvider));
            }
            Err(GitHostError::CliNotInstalled { provider }) => {
                return Err(pr_error(PrError::CliNotInstalled { provider }));
            }
            Err(error) => return Err(internal_error(error)),
        };
        let provider = git_host.provider_kind();
        let mut title = args.title;
        let mut body = args.body;
        if args.auto_generate_description.unwrap_or(false) {
            let task = workspace
                .parent_task(&self.pool)
                .await
                .map_err(internal_error)?;
            let remote_base = format!("{}/{}", target_remote.name, base_branch);
            match generate_pr_description_host(
                self,
                task.as_ref().map(|task| task.title.clone()),
                task.as_ref().and_then(|task| task.description.clone()),
                &worktree_path,
                &base_branch,
                &workspace.branch,
                &[remote_base, base_branch.clone()],
            )
            .await
            {
                Ok(generated) => {
                    title = generated.0;
                    body = Some(generated.1);
                }
                Err(error) => tracing::warn!(%error, "PR description generation failed"),
            }
        }
        let pr_request = CreatePrRequest {
            title: title.clone(),
            body: body.clone(),
            head_branch: workspace.branch.clone(),
            base_branch: base_branch.clone(),
            draft: args.draft,
            head_repo_url: Some(push_remote.url.clone()),
        };
        match git_host
            .create_pr(&repo.path, &target_remote.url, &pr_request)
            .await
        {
            Ok(pr_info) => {
                if let Err(error) = Merge::create_pr(
                    &self.pool,
                    workspace.id,
                    workspace_repo.repo_id,
                    &base_branch,
                    pr_info.number,
                    &pr_info.url,
                )
                .await
                {
                    tracing::error!("Failed to update workspace PR status: {error}");
                }
                if let Err(error) = utils::browser::open_browser(&pr_info.url).await {
                    tracing::warn!("Failed to open PR in browser: {error}");
                }
                serialize(pr_info.url)
            }
            Err(error) => match &error {
                GitHostError::CliNotInstalled { provider } => {
                    Err(pr_error(PrError::CliNotInstalled {
                        provider: *provider,
                    }))
                }
                GitHostError::AuthFailed(_) => Err(pr_error(PrError::CliNotLoggedIn { provider })),
                _ => Err(internal_error(error)),
            },
        }
    }

    pub(crate) async fn create_workspace_from_pr_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let payload: CreateWorkspaceFromPrRequest = parse(args)?;
        let repo = Repo::find_by_id(&self.pool, payload.repo_id)
            .await
            .map_err(internal_error)?
            .ok_or(RepoError::NotFound)
            .map_err(internal_error)?;
        let project_repos = ProjectRepo::find_by_repo_id(&self.pool, payload.repo_id)
            .await
            .map_err(internal_error)?;
        let Some(project_id) = project_repos.first().map(|row| row.project_id) else {
            return Err(create_from_pr_error(CreateFromPrError::RepoNotInProject));
        };
        let git = self.deployment.git().clone();
        let repo_path_for_git = repo.path.clone();
        let requested_remote = payload.remote_name.clone();
        let remote = tokio::task::spawn_blocking(move || match requested_remote {
            Some(name) => Ok(GitRemote {
                url: git.get_remote_url(&repo_path_for_git, &name)?,
                name,
            }),
            None => git.get_default_remote(&repo_path_for_git),
        })
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
        let target_branch_ref = format!("{}/{}", remote.name, payload.base_branch);
        let task = Task::create(
            &self.pool,
            &CreateTask {
                project_id,
                title: payload.pr_title.clone(),
                description: Some(format!(
                    "Created from PR #{}: {}",
                    payload.pr_number, payload.pr_url
                )),
                status: Some(TaskStatus::InProgress),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .map_err(internal_error)?;
        let workspace_id = Uuid::new_v4();
        let mut workspace = Workspace::create(
            &self.pool,
            &CreateWorkspace {
                project_id: task.project_id,
                parent_workspace_id: task.parent_workspace_id,
                branch: target_branch_ref.clone(),
                container_ref: None,
                use_worktree: true,
                agent_working_dir: Some(repo.name.clone()),
            },
            workspace_id,
            task.id,
        )
        .await
        .map_err(internal_error)?;
        WorkspaceRepo::create_many(
            &self.pool,
            workspace.id,
            &[CreateWorkspaceRepo {
                repo_id: payload.repo_id,
                target_branch: target_branch_ref.clone(),
            }],
        )
        .await
        .map_err(internal_error)?;
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        workspace.container_ref = Some(container_ref.clone());
        let worktree_path = workspace
            .repo_path(&repo)
            .unwrap_or_else(|| PathBuf::from(&container_ref));
        let remote_url = remote.url.clone();
        let pr_number = payload.pr_number;
        tokio::task::spawn_blocking(move || {
            let gh = services::services::git_host::github::GhCli::new();
            let repo_info = gh
                .get_repo_info(&remote_url, &worktree_path)
                .map_err(|error| {
                    create_from_pr_error(CreateFromPrError::BranchFetchFailed {
                        message: format!("Failed to get repository info: {error}"),
                    })
                })?;
            gh.pr_checkout(
                &worktree_path,
                &repo_info.owner,
                &repo_info.repo_name,
                pr_number,
            )
            .map_err(|error| {
                create_from_pr_error(CreateFromPrError::BranchFetchFailed {
                    message: error.to_string(),
                })
            })?;
            Ok::<(), ApplicationError>(())
        })
        .await
        .map_err(internal_error)??;
        Workspace::update_branch_name(&self.pool, workspace.id, &payload.head_branch)
            .await
            .map_err(internal_error)?;
        workspace.branch = payload.head_branch.clone();
        Merge::create_pr(
            &self.pool,
            workspace.id,
            payload.repo_id,
            &format!("{}/{}", remote.name, payload.base_branch),
            payload.pr_number,
            &payload.pr_url,
        )
        .await
        .map_err(internal_error)?;
        if payload.run_setup {
            let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?;
            if let Some(setup_action) = container_actions::setup_actions_for_repos(&repos) {
                let session = ensure_workspace_session(&self.pool, workspace.id).await?;
                if let Err(error) = self
                    .deployment
                    .container()
                    .start_execution(
                        &workspace,
                        &session,
                        &setup_action,
                        &ExecutionProcessRunReason::SetupScript,
                    )
                    .await
                {
                    tracing::error!("Failed to run setup script: {error}");
                }
            }
        }
        let workspace = Workspace::find_by_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Workspace not found after creation"))?;
        serialize(CreateWorkspaceFromPrResponse { workspace, task })
    }

    pub(crate) async fn create_task_and_start_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let payload: CreateAndStartTaskRequest = parse(args)?;
        if payload.repos.is_empty() {
            return Err(ApplicationError::bad_request(
                "At least one repository is required",
            ));
        }
        let workspace_repos: Vec<CreateWorkspaceRepo> = payload
            .repos
            .iter()
            .map(|repo| CreateWorkspaceRepo {
                repo_id: repo.repo_id,
                target_branch: repo.target_branch.clone(),
            })
            .collect();
        let primary_repo = if payload.repos.len() == 1 {
            Some(
                Repo::find_by_id(&self.pool, payload.repos[0].repo_id)
                    .await
                    .map_err(internal_error)?
                    .ok_or(RepoError::NotFound)
                    .map_err(internal_error)?,
            )
        } else {
            None
        };
        let reusable_workspace_id = if payload.use_worktree {
            None
        } else {
            WorkspaceRepo::find_reusable_non_worktree_workspace_id(
                &self.pool,
                payload.task.project_id,
                &workspace_repos,
            )
            .await
            .map_err(internal_error)?
        };
        if !payload.use_worktree && reusable_workspace_id.is_none() && payload.repos.len() != 1 {
            return Err(ApplicationError::bad_request(
                "Creating a non-worktree workspace currently requires a single repository unless an existing matching workspace can be reused",
            ));
        }
        let task = Task::create(&self.pool, &payload.task, Uuid::new_v4())
            .await
            .map_err(internal_error)?;
        if let Some(image_ids) = &payload.task.image_ids {
            TaskImage::associate_many_dedup(&self.pool, task.id, image_ids)
                .await
                .map_err(internal_error)?;
        }
        let workspace = if let Some(workspace_id) = reusable_workspace_id {
            Workspace::find_by_id(&self.pool, workspace_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    ApplicationError::not_found(format!("Workspace {workspace_id} not found"))
                })?
        } else {
            let attempt_id = Uuid::new_v4();
            let git_branch_name = if payload.use_worktree {
                self.deployment
                    .container()
                    .git_branch_from_workspace(&attempt_id, &task.title)
                    .await
            } else {
                let repo = primary_repo.as_ref().ok_or_else(|| {
                    ApplicationError::bad_request(
                        "Opening the current branch without a worktree requires one repository",
                    )
                })?;
                let git = self.deployment.git().clone();
                let repo_path = repo.path.clone();
                tokio::task::spawn_blocking(move || git.get_current_branch(&repo_path))
                    .await
                    .map_err(internal_error)?
                    .map_err(internal_error)?
            };
            let agent_working_dir = if payload.repos.len() == 1 {
                let repo = primary_repo
                    .as_ref()
                    .ok_or(RepoError::NotFound)
                    .map_err(internal_error)?;
                match &repo.default_working_dir {
                    Some(subdir) => {
                        if payload.use_worktree {
                            Some(
                                PathBuf::from(&repo.name)
                                    .join(subdir)
                                    .to_string_lossy()
                                    .into_owned(),
                            )
                        } else {
                            Some(subdir.clone())
                        }
                    }
                    None => payload.use_worktree.then(|| repo.name.clone()),
                }
            } else {
                None
            };
            let container_ref = if payload.use_worktree {
                None
            } else {
                Some(
                    primary_repo
                        .as_ref()
                        .ok_or(RepoError::NotFound)
                        .map_err(internal_error)?
                        .path
                        .to_string_lossy()
                        .into_owned(),
                )
            };
            let workspace = Workspace::create(
                &self.pool,
                &CreateWorkspace {
                    project_id: task.project_id,
                    parent_workspace_id: task.parent_workspace_id,
                    branch: git_branch_name,
                    container_ref,
                    use_worktree: payload.use_worktree,
                    agent_working_dir,
                },
                attempt_id,
                task.id,
            )
            .await
            .map_err(internal_error)?;
            WorkspaceRepo::create_many(&self.pool, workspace.id, &workspace_repos)
                .await
                .map_err(internal_error)?;
            Workspace::update(
                &self.pool,
                workspace.id,
                None,
                None,
                Some(task.title.as_str()),
            )
            .await
            .map_err(internal_error)?;
            Workspace::find_by_id(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    ApplicationError::not_found(format!("Workspace {} not found", workspace.id))
                })?
        };
        let parsed_agent_id = AgentId::parse(&payload.executor_profile_id.executor).ok();
        let session = Session::create(
            &self.pool,
            &CreateSession {
                executor: Some(payload.executor_profile_id.executor.to_string()),
                agent_id: parsed_agent_id,
                provider_instance_id: None,
                task_id: Some(task.id),
                name: Some(task.title.clone()),
                initial_prompt: task.description.clone(),
                status: Some(task_status_to_session_status(&task.status)),
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .map_err(internal_error)?;
        let started = self
            .start_task_attempt(&workspace, &session, &task, &payload.executor_profile_id)
            .await
            .inspect_err(|error| {
                tracing::error!("Failed to start ACP-native task attempt: {error}")
            })
            .is_ok();
        let task = Task::find_by_id(&self.pool, task.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Task not found after creation"))?;
        serialize(TaskWithAttemptStatus {
            task,
            has_in_progress_attempt: started,
            last_attempt_failed: false,
            executor: payload.executor_profile_id.executor.to_string(),
        })
    }

    async fn start_task_attempt(
        &self,
        workspace: &Workspace,
        session: &Session,
        task: &Task,
        profile: &ExecutorProfileId,
    ) -> Result<(), ApplicationError> {
        let agent_id = AgentId::parse(&profile.executor)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let text = session
            .initial_prompt
            .clone()
            .filter(|prompt| !prompt.trim().is_empty())
            .unwrap_or_else(|| task.to_prompt());
        let service = conversations::ConversationSessionService::new(self.conversations.clone());
        service
            .start_turn(conversations::ConversationStartTurnInput {
                continuation_policy: Some(agents::conversation::ContinuationPolicy::Portable),
                expected_binding_revision: None,
                agent_id,
                provider_instance_id: None,
                workspace_id: workspace.id,
                conversation_id: session.id,
                executor_profile_id: Some(profile.clone()),
                text,
                display_text: None,
                images: Vec::new(),
                mode_override: None,
                config_overrides: Vec::new(),
                workflow_refs: Vec::new(),
                file_refs: Vec::new(),
                internal_prompt_contributions: Vec::new(),
                queued_input_claim: None,
                operation_id: Some(Uuid::new_v4()),
                collaboration_origin: None,
            })
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(())
    }
}

fn branch_status_for_repo(
    git: &git::GitService,
    workspace: &Workspace,
    repo: &Repo,
    worktree_path: &Path,
    target_branch: &str,
    repo_merges: Vec<Merge>,
) -> Result<BranchStatus, ApplicationError> {
    let head_oid = git.get_head_info(worktree_path).ok().map(|head| head.oid);
    let is_rebase_in_progress = git.is_rebase_in_progress(worktree_path).unwrap_or(false);
    let conflicted_files = git.get_conflicted_files(worktree_path).unwrap_or_default();
    let conflict_op = if conflicted_files.is_empty() {
        None
    } else {
        git.detect_conflict_op(worktree_path).unwrap_or(None)
    };
    let (uncommitted_count, untracked_count) = match git.get_worktree_change_counts(worktree_path) {
        Ok((uncommitted, untracked)) => (Some(uncommitted), Some(untracked)),
        Err(_) => (None, None),
    };
    let target_branch_type = git
        .find_branch_type(&repo.path, target_branch)
        .map_err(internal_error)?;
    let (commits_ahead, commits_behind) = match target_branch_type {
        BranchType::Local => {
            let (ahead, behind) = git
                .get_branch_status(&repo.path, &workspace.branch, target_branch)
                .map_err(internal_error)?;
            (Some(ahead), Some(behind))
        }
        BranchType::Remote => {
            let (ahead, behind) = git
                .get_remote_branch_status(&repo.path, &workspace.branch, Some(target_branch))
                .map_err(internal_error)?;
            (Some(ahead), Some(behind))
        }
    };
    let (remote_ahead, remote_behind) = if let Some(Merge::Pr(PrMerge {
        pr_info: PullRequestInfo {
            status: MergeStatus::Open,
            ..
        },
        ..
    })) = repo_merges.first()
    {
        match git.get_remote_branch_status(&repo.path, &workspace.branch, None) {
            Ok((ahead, behind)) => (Some(ahead), Some(behind)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };
    Ok(BranchStatus {
        commits_ahead,
        commits_behind,
        has_uncommitted_changes: uncommitted_count.map(|count| count > 0),
        head_oid,
        uncommitted_count,
        untracked_count,
        remote_commits_ahead: remote_ahead,
        remote_commits_behind: remote_behind,
        merges: repo_merges,
        target_branch_name: target_branch.to_string(),
        is_rebase_in_progress,
        conflict_op,
        conflicted_files,
        is_target_remote: target_branch_type == BranchType::Remote,
    })
}

async fn ensure_workspace_session(
    pool: &sqlx::SqlitePool,
    workspace_id: Uuid,
) -> Result<Session, ApplicationError> {
    if let Some(session) = Session::find_latest_by_workspace_id(pool, workspace_id)
        .await
        .map_err(internal_error)?
    {
        return Ok(session);
    }
    Session::create(
        pool,
        &CreateSession {
            executor: None,
            agent_id: None,
            provider_instance_id: None,
            task_id: None,
            name: None,
            initial_prompt: None,
            status: Some(SessionStatus::Todo),
        },
        Uuid::new_v4(),
        workspace_id,
    )
    .await
    .map_err(internal_error)
}

fn task_status_to_session_status(status: &TaskStatus) -> SessionStatus {
    match status {
        TaskStatus::Todo => SessionStatus::Todo,
        TaskStatus::InProgress => SessionStatus::InProgress,
        TaskStatus::InReview => SessionStatus::InReview,
        TaskStatus::Done | TaskStatus::Cancelled => SessionStatus::Done,
    }
}

async fn generate_pr_description_host(
    domains: &ServerApplicationDomains,
    task_title: Option<String>,
    task_description: Option<String>,
    worktree_path: &std::path::Path,
    base_branch: &str,
    head_branch: &str,
    base_ref_candidates: &[String],
) -> Result<(String, String), ApplicationError> {
    use services::services::pr_description::{
        PrDescriptionContext, build_pr_description_payload, extract_pr_description,
        selected_pr_description_agent, validate_pr_description_request,
    };
    let config = domains.deployment.config().read().await.clone();
    validate_pr_description_request(&config)
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let agent_id = selected_pr_description_agent(&config)
        .ok_or_else(|| ApplicationError::bad_request("PR description Agent is not configured"))?;
    let agent_id = AgentId::parse(agent_id)
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let worktree_for_git = worktree_path.to_path_buf();
    let candidates = base_ref_candidates.to_vec();
    let (commit_log, diff_stat, diff) = tokio::task::spawn_blocking(move || {
        let git = git::GitCli::new();
        let base_ref = candidates.iter().find(|candidate| {
            git.git(
                &worktree_for_git,
                ["rev-parse", "--verify", candidate.as_str()],
            )
            .is_ok()
        });
        if let Some(base_ref) = base_ref {
            let range = format!("{base_ref}..HEAD");
            let triple_dot = format!("{base_ref}...HEAD");
            (
                git.git(&worktree_for_git, ["log", "--format=%h %s", &range])
                    .unwrap_or_default(),
                git.git(&worktree_for_git, ["diff", "--stat", &triple_dot])
                    .unwrap_or_default(),
                git.git(&worktree_for_git, ["diff", &triple_dot])
                    .unwrap_or_default(),
            )
        } else {
            (String::new(), String::new(), String::new())
        }
    })
    .await
    .map_err(internal_error)?;
    let prompt_text = build_pr_description_payload(
        &config,
        &PrDescriptionContext {
            task_title,
            task_description,
            base_branch: base_branch.to_string(),
            head_branch: head_branch.to_string(),
            commit_log,
            diff_stat,
            diff,
        },
    )
    .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let launch = domains
        .conversations
        .host
        .launch_settings(&domains.pool, &agent_id)
        .await
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let runtime = &domains.conversations.agent_runtime;
    let events = runtime.subscribe_events();
    let working_dir = utils::path::dimo_scratch_subdir("pr-description").map_err(internal_error)?;
    let prepared = runtime
        .prepare_session(EnsureAgentSessionInput {
            agent_id: agent_id.clone(),
            launch_lock: launch.launch_lock,
            workspace_id: Uuid::nil(),
            working_dir,
            additional_directories: Vec::new(),
            session_id: AgentSessionId::new(),
            acp_session_id: String::new(),
            auto_approve_mode: launch.auto_approve_mode,
            env: launch.env,
            preferences: Default::default(),
        })
        .await
        .map_err(internal_error)?;
    let session = prepared.session;
    runtime.commit_prepared_session(session.id).await;
    runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text { text: prompt_text }],
            mode_override: config.pr_auto_description_mode.clone(),
            config_overrides: config
                .pr_auto_description_session_config
                .iter()
                .map(|(key, value)| agents::events::AgentSessionConfigOverride {
                    key: key.clone(),
                    value: value.clone(),
                })
                .collect(),
        })
        .await
        .map_err(internal_error)?;
    let response_text = match tokio::time::timeout(
        std::time::Duration::from_secs(
            services::services::pr_description::PR_DESCRIPTION_TIMEOUT_SECS,
        ),
        collect_pr_response_text(events, session.id, session.connection_id),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            let _ = runtime.disconnect(session.connection_id).await;
            return Err(ApplicationError::internal("PR description Agent timed out"));
        }
    };
    let _ = runtime.disconnect(session.connection_id).await;
    extract_pr_description(&response_text)
        .map(|draft| (draft.title, draft.body))
        .ok_or_else(|| {
            ApplicationError::internal("PR description Agent did not return Title and Body fields")
        })
}

async fn collect_pr_response_text(
    mut events: tokio::sync::broadcast::Receiver<agents::events::AgentEventEnvelope>,
    session_id: AgentSessionId,
    connection_id: agents::AgentConnectionId,
) -> Result<String, ApplicationError> {
    use agents::events::AgentEvent;
    use tokio::sync::broadcast::error::RecvError;
    let mut response_text = String::new();
    loop {
        let envelope = match events.recv().await {
            Ok(envelope) => envelope,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => {
                return Err(ApplicationError::internal(
                    "PR description failed: Agent event stream closed",
                ));
            }
        };
        if envelope.session_id != Some(session_id) {
            continue;
        }
        match envelope.event {
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => response_text.push_str(&text),
            AgentEvent::PromptFinished { .. } => return Ok(response_text),
            AgentEvent::Error { error } => {
                return Err(ApplicationError::internal(format!(
                    "PR description Agent failed: {}",
                    error.message
                )));
            }
            _ => {}
        }
        let _ = connection_id;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn create_workspace_from_pr_accepts_snake_case_and_camel_case() {
        let repo_id = Uuid::new_v4();
        let snake: CreateWorkspaceFromPrRequest = parse(json!({
            "payload": {
                "repo_id": repo_id,
                "pr_number": 42,
                "pr_title": "Fix bug",
                "pr_url": "https://github.com/acme/repo/pull/42",
                "head_branch": "fix/bug",
                "base_branch": "main",
                "run_setup": true,
                "remote_name": "origin"
            }
        }))
        .expect("snake_case CreateWorkspaceFromPrRequest");
        assert_eq!(snake.repo_id, repo_id);
        assert_eq!(snake.pr_number, 42);
        assert!(snake.run_setup);
        assert_eq!(snake.remote_name.as_deref(), Some("origin"));

        let camel: CreateWorkspaceFromPrRequest = parse(json!({
            "repoId": repo_id,
            "prNumber": 7,
            "prTitle": "Feat",
            "prUrl": "https://github.com/acme/repo/pull/7",
            "headBranch": "feat/x",
            "baseBranch": "main",
            "runSetup": false
        }))
        .expect("camelCase CreateWorkspaceFromPrRequest");
        assert_eq!(camel.pr_number, 7);
        assert!(!camel.run_setup);
    }

    #[test]
    fn create_and_start_task_accepts_snake_case_frontend_dto() {
        let project_id = Uuid::new_v4();
        let repo_id = Uuid::new_v4();
        let req: CreateAndStartTaskRequest = parse(json!({
            "payload": {
                "task": {
                    "project_id": project_id,
                    "title": "Ship fix",
                    "description": null,
                    "status": null,
                    "parent_workspace_id": null,
                    "image_ids": null
                },
                "executor_profile_id": {
                    "executor": "claude",
                    "variant": null
                },
                "repos": [{
                    "repo_id": repo_id,
                    "target_branch": "main"
                }],
                "use_worktree": false
            }
        }))
        .expect("snake_case CreateAndStartTaskRequest");
        assert_eq!(req.task.project_id, project_id);
        assert_eq!(req.executor_profile_id.executor.as_str(), "claude");
        assert_eq!(req.repos.len(), 1);
        assert_eq!(req.repos[0].repo_id, repo_id);
        assert_eq!(req.repos[0].target_branch, "main");
        assert!(!req.use_worktree);
    }

    #[test]
    fn typed_workspace_errors_populate_structured_application_error_details() {
        let err = run_script_error(RunScriptError::NoScriptConfigured);
        assert_eq!(
            err.envelope().details,
            Some(json!({ "type": "no_script_configured" }))
        );

        let err = run_script_error(RunScriptError::ProcessAlreadyRunning);
        assert_eq!(
            err.envelope().details,
            Some(json!({ "type": "process_already_running" }))
        );

        let err = pr_error(PrError::TargetBranchNotFound {
            branch: "main".into(),
        });
        assert_eq!(
            err.envelope().details,
            Some(json!({ "type": "target_branch_not_found", "branch": "main" }))
        );

        let err = create_from_pr_error(CreateFromPrError::RepoNotInProject);
        assert_eq!(
            err.envelope().details,
            Some(json!({ "type": "repo_not_in_project" }))
        );
    }
}
