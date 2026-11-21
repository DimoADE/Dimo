//! Desktop launcher & local settings helpers:
//! - Editor launch (`open_project_in_editor`, `open_workspace_in_editor`, `open_repo_in_editor`, `open_in_editor`)
//! - External terminal launch (`open_external_terminal`)
//! - Persisted developer mode switch (`read_developer_mode`, `write_developer_mode`) sharing `settings.json` `system.developer_mode` with Tauri.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use db::models::{
    project::Project,
    repo::Repo,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use local_deployment::LocalDeployment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::error::DesktopError;

const SYSTEM_SECTION: &str = "system";

#[derive(Debug, Clone, Default, Deserialize)]
pub struct OpenEditorRequest {
    #[serde(default, alias = "editorType")]
    pub editor_type: Option<String>,
    #[serde(default, alias = "gitRepoPath")]
    pub git_repo_path: Option<PathBuf>,
    #[serde(default, alias = "filePath")]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

pub fn developer_mode_from_document(raw: &str) -> Option<bool> {
    let value: Value = serde_json::from_str(raw).ok()?;
    Some(
        value
            .get(SYSTEM_SECTION)
            .and_then(|section| section.get("developer_mode"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

pub fn read_developer_mode() -> bool {
    let Ok(raw) = std::fs::read_to_string(utils::assets::settings_path()) else {
        return false;
    };
    developer_mode_from_document(&raw).unwrap_or(false)
}

pub async fn write_developer_mode(enabled: bool) -> Result<bool, DesktopError> {
    let mut updates = serde_json::Map::new();
    updates.insert("developer_mode".to_string(), Value::Bool(enabled));
    services::services::settings_store::merge_object_section(
        &utils::assets::settings_path(),
        SYSTEM_SECTION,
        updates,
    )
    .await
    .map_err(|error| DesktopError::Internal(error.to_string()))?;
    Ok(enabled)
}

fn rebuild_relative_path(segments: &[String]) -> Option<String> {
    if segments.is_empty() {
        return None;
    }

    let mut path = PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    Some(path.to_string_lossy().to_string())
}

fn workspace_with_container_ref(workspace: &Workspace, container_ref: &str) -> Workspace {
    let mut next = workspace.clone();
    next.container_ref = Some(container_ref.to_string());
    next
}

fn single_repo_base_path_is_repo_root(
    workspace: &Workspace,
    container_ref: &str,
    repo: &Repo,
) -> bool {
    if !workspace.use_worktree {
        return true;
    }

    workspace_with_container_ref(workspace, container_ref)
        .repo_path(repo)
        .is_some_and(|path| path == Path::new(container_ref))
}

fn normalized_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let raw = workspace
        .agent_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())?;

    let [repo] = repos else {
        return Some(raw.to_string());
    };

    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);
    let mut segments = raw
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if container_is_repo_root
        && segments
            .first()
            .is_some_and(|segment| segment == &repo.name)
    {
        segments.remove(0);
        return rebuild_relative_path(&segments);
    }

    let missing_repo_prefix = match segments.first() {
        Some(segment) => segment != &repo.name,
        None => true,
    };

    if workspace.use_worktree && !container_is_repo_root && missing_repo_prefix {
        segments.insert(0, repo.name.clone());
        return rebuild_relative_path(&segments);
    }

    Some(raw.to_string())
}

fn infer_single_repo_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let [repo] = repos else {
        return None;
    };

    let default_working_dir = repo
        .default_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty());

    if !workspace.use_worktree {
        return default_working_dir.map(ToOwned::to_owned);
    }

    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);

    match default_working_dir {
        Some(subdir) if container_is_repo_root => Some(subdir.to_string()),
        Some(subdir) => Some(
            PathBuf::from(&repo.name)
                .join(subdir)
                .to_string_lossy()
                .to_string(),
        ),
        None if container_is_repo_root => None,
        None => Some(repo.name.clone()),
    }
}

fn resolve_workspace_base_path(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> PathBuf {
    let container_path = PathBuf::from(container_ref);
    let [repo] = repos else {
        return container_path;
    };

    if !workspace.use_worktree {
        return repo.path.clone();
    }

    container_path
}

pub fn resolve_workspace_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    normalized_agent_working_dir(workspace, container_ref, repos)
        .or_else(|| infer_single_repo_working_dir(workspace, container_ref, repos))
}

pub fn resolve_workspace_repo_root(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> PathBuf {
    let [repo] = repos else {
        return PathBuf::from(container_ref);
    };

    if !workspace.use_worktree {
        return repo.path.clone();
    }

    workspace_with_container_ref(workspace, container_ref)
        .repo_path(repo)
        .unwrap_or_else(|| PathBuf::from(container_ref))
}

pub fn resolve_workspace_default_open_path(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> PathBuf {
    let base_path = resolve_workspace_base_path(workspace, container_ref, repos);

    if let Some(working_dir) = resolve_workspace_agent_working_dir(workspace, container_ref, repos)
    {
        return base_path.join(working_dir);
    }

    resolve_workspace_repo_root(workspace, container_ref, repos)
}

fn resolve_editor_target_path(base_path: &Path, file_path: Option<&str>) -> PathBuf {
    let Some(trimmed) = file_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return base_path.to_path_buf();
    };
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base_path.join(candidate)
    }
}

pub async fn open_project_in_editor(
    deployment: &LocalDeployment,
    id: Uuid,
    payload: Option<OpenEditorRequest>,
) -> Result<OpenEditorResponse, DesktopError> {
    let pool = &deployment.db().pool;
    let project = Project::find_by_id(pool, id)
        .await?
        .ok_or_else(|| DesktopError::NotFound(format!("Project {id} not found")))?;

    let base_path = if let Some(ref req) = payload
        && let Some(ref specified_path) = req.git_repo_path
    {
        specified_path.clone()
    } else {
        let repositories = deployment
            .project()
            .get_repositories(pool, project.id)
            .await
            .map_err(|error| DesktopError::Internal(error.to_string()))?;

        repositories
            .first()
            .map(|repo| repo.path.clone())
            .ok_or_else(|| DesktopError::BadRequest("Project has no repositories".to_string()))?
    };

    let target_path = resolve_editor_target_path(
        &base_path,
        payload.as_ref().and_then(|req| req.file_path.as_deref()),
    );
    let editor_type = payload.as_ref().and_then(|req| req.editor_type.as_deref());
    open_path_in_editor(deployment, &target_path, editor_type).await
}

pub async fn open_repo_in_editor(
    deployment: &LocalDeployment,
    repo_id: Uuid,
    payload: Option<OpenEditorRequest>,
) -> Result<OpenEditorResponse, DesktopError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await
        .map_err(|error| DesktopError::Internal(error.to_string()))?;

    let target_path = resolve_editor_target_path(
        &repo.path,
        payload.as_ref().and_then(|req| req.file_path.as_deref()),
    );
    let editor_type = payload.as_ref().and_then(|req| req.editor_type.as_deref());
    open_path_in_editor(deployment, &target_path, editor_type).await
}

pub async fn open_workspace_in_editor(
    deployment: &LocalDeployment,
    workspace_id: Uuid,
    editor_type: Option<String>,
    file_path: Option<String>,
) -> Result<OpenEditorResponse, DesktopError> {
    let pool = &deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| DesktopError::NotFound(format!("Workspace {workspace_id} not found")))?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
        .map_err(|error| DesktopError::Internal(error.to_string()))?;

    Workspace::touch(pool, workspace.id).await?;

    let workspace_repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let path = if let Some(ref fp) = file_path {
        resolve_workspace_repo_root(&workspace, &container_ref, &workspace_repos).join(fp)
    } else {
        resolve_workspace_default_open_path(&workspace, &container_ref, &workspace_repos)
    };

    open_path_in_editor(deployment, &path, editor_type.as_deref()).await
}

pub async fn open_in_editor(
    deployment: &LocalDeployment,
    path: &Path,
    editor_type: Option<&str>,
) -> Result<OpenEditorResponse, DesktopError> {
    open_path_in_editor(deployment, path, editor_type).await
}

async fn open_path_in_editor(
    deployment: &LocalDeployment,
    path: &Path,
    editor_type: Option<&str>,
) -> Result<OpenEditorResponse, DesktopError> {
    let editor_config = {
        let config = deployment.config().read().await;
        config.editor.with_override(editor_type)
    };

    match editor_config.open_file(path).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor at path: {}{}",
                path.display(),
                if url.is_some() { " (remote mode)" } else { "" }
            );
            Ok(OpenEditorResponse { url })
        }
        Err(error) => {
            tracing::error!("Failed to open editor at {}: {:?}", path.display(), error);
            Err(DesktopError::Internal(format!(
                "Failed to open editor: {error}"
            )))
        }
    }
}

async fn resolve_terminal_working_dir(
    deployment: &LocalDeployment,
    workspace_id: Uuid,
) -> Result<PathBuf, DesktopError> {
    let pool = &deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| DesktopError::NotFound("Workspace not found".to_string()))?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
        .map_err(|error| DesktopError::Internal(error.to_string()))?;
    let workspace_repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let working_dir =
        resolve_workspace_default_open_path(&workspace, &container_ref, &workspace_repos);
    if !working_dir.exists() {
        return Err(DesktopError::NotFound(
            "Workspace directory does not exist".to_string(),
        ));
    }

    Ok(working_dir)
}

pub async fn open_external_terminal(
    deployment: &LocalDeployment,
    workspace_id: Uuid,
    terminal_app: String,
) -> Result<(), DesktopError> {
    let working_dir = resolve_terminal_working_dir(deployment, workspace_id).await?;
    let app = terminal_app.trim().to_ascii_lowercase();

    #[cfg(target_os = "macos")]
    {
        match app.as_str() {
            "terminal" => {
                Command::new("open")
                    .arg("-a")
                    .arg("Terminal")
                    .arg(&working_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|err| {
                        DesktopError::Internal(format!("Failed to launch Terminal: {err}"))
                    })?;
            }
            "iterm2" | "iterm" => {
                Command::new("open")
                    .arg("-a")
                    .arg("iTerm")
                    .arg(&working_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|err| {
                        DesktopError::Internal(format!("Failed to launch iTerm2: {err}"))
                    })?;
            }
            "ghostty" => {
                Command::new("open")
                    .arg("-a")
                    .arg("Ghostty")
                    .arg(&working_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|err| {
                        DesktopError::Internal(format!("Failed to launch Ghostty: {err}"))
                    })?;
            }
            "warp" => {
                open_warp_terminal(&working_dir)?;
            }
            other => {
                return Err(DesktopError::BadRequest(format!(
                    "Unsupported terminal app: {other}"
                )));
            }
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        match app.as_str() {
            "terminal" | "wt" => {
                Command::new("wt")
                    .arg("-d")
                    .arg(&working_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|err| {
                        DesktopError::Internal(format!("Failed to launch Windows Terminal: {err}"))
                    })?;
            }
            "ghostty" => {
                Command::new("ghostty")
                    .current_dir(&working_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|err| {
                        DesktopError::Internal(format!("Failed to launch Ghostty: {err}"))
                    })?;
            }
            "warp" => {
                open_warp_terminal(&working_dir)?;
            }
            other => {
                return Err(DesktopError::BadRequest(format!(
                    "Unsupported terminal app: {other}"
                )));
            }
        }
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match app.as_str() {
            "terminal" => {
                Command::new("x-terminal-emulator")
                    .current_dir(&working_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|err| {
                        DesktopError::Internal(format!("Failed to launch terminal: {err}"))
                    })?;
            }
            "ghostty" => {
                Command::new("ghostty")
                    .current_dir(&working_dir)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|err| {
                        DesktopError::Internal(format!("Failed to launch Ghostty: {err}"))
                    })?;
            }
            "warp" => {
                open_warp_terminal(&working_dir)?;
            }
            other => {
                return Err(DesktopError::BadRequest(format!(
                    "Unsupported terminal app: {other}"
                )));
            }
        }
        Ok(())
    }
}

fn open_warp_terminal(working_dir: &Path) -> Result<(), DesktopError> {
    let encoded_path = percent_encode_query_component(&working_dir.to_string_lossy());
    let warp_uri = format!("warp://action/new_window?path={encoded_path}");

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&warp_uri)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|err| DesktopError::Internal(format!("Failed to launch Warp: {err}")))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/C", "start", "", &warp_uri])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|err| DesktopError::Internal(format!("Failed to launch Warp: {err}")))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&warp_uri)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|err| DesktopError::Internal(format!("Failed to launch Warp: {err}")))?;
        Ok(())
    }
}

pub fn percent_encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let is_unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/');
        if is_unreserved {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use db::models::{repo::Repo, workspace::Workspace};

    use super::*;

    fn sample_repo(name: &str, default_working_dir: Option<&str>) -> Repo {
        Repo {
            id: Uuid::new_v4(),
            path: PathBuf::from(format!("C:/repos/{name}")),
            name: name.to_string(),
            display_name: name.to_string(),
            setup_script: None,
            cleanup_script: None,
            archive_script: None,
            copy_files: None,
            parallel_setup_script: false,
            dev_server_script: Some("npm run dev".to_string()),
            default_target_branch: None,
            default_working_dir: default_working_dir.map(ToOwned::to_owned),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn sample_workspace(use_worktree: bool) -> Workspace {
        Workspace {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            parent_workspace_id: None,
            container_ref: None,
            branch: "main".to_string(),
            use_worktree,
            agent_working_dir: None,
            setup_completed_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived: false,
            pinned: false,
            name: None,
        }
    }

    #[test]
    fn encodes_warp_query_paths() {
        assert_eq!(
            percent_encode_query_component("/Users/demo/My Project#1"),
            "/Users/demo/My%20Project%231"
        );
    }

    #[test]
    fn parses_developer_mode_from_settings_json() {
        assert_eq!(
            developer_mode_from_document(r#"{"system":{"developer_mode":true}}"#),
            Some(true)
        );
        assert_eq!(
            developer_mode_from_document(r#"{"system":{"proxy":{"mode":"auto"}}}"#),
            Some(false)
        );
        assert_eq!(developer_mode_from_document("{}"), Some(false));
        assert_eq!(developer_mode_from_document("not-json"), None);
    }

    #[test]
    fn resolves_single_repo_worktree_default_open_path() {
        let mut workspace = sample_workspace(true);
        workspace.agent_working_dir = Some("frontend".to_string());
        let repo = sample_repo("app-main", Some("frontend"));

        assert_eq!(
            resolve_workspace_repo_root(
                &workspace,
                "C:/worktrees/app-feature-b",
                std::slice::from_ref(&repo),
            ),
            PathBuf::from("C:/worktrees/app-feature-b")
        );
        assert_eq!(
            resolve_workspace_default_open_path(
                &workspace,
                "C:/worktrees/app-feature-b",
                std::slice::from_ref(&repo),
            ),
            PathBuf::from("C:/worktrees/app-feature-b/frontend")
        );
    }
}
