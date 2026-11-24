use super::*;

pub(super) async fn ensure_managed_uv(managed_artifacts_dir: &Path) -> anyhow::Result<PathBuf> {
    let platform = current_platform();
    let artifact = managed_uv_artifact(&platform)
        .ok_or_else(|| anyhow::anyhow!("uv is not supported on {platform}"))?;
    let final_executable = managed_uv_executable(managed_artifacts_dir)
        .ok_or_else(|| anyhow::anyhow!("could not resolve managed uv path"))?;
    if tokio::fs::metadata(&final_executable).await.is_ok() {
        tracing::info!(
            "Using managed uv {MANAGED_UV_VERSION}: {}",
            final_executable.display()
        );
        return Ok(final_executable);
    }

    let base = managed_artifacts_dir.join("agent-tools").join("uv");
    tokio::fs::create_dir_all(&base).await?;
    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let urls = managed_uv_download_urls(&artifact);
    tracing::info!("Downloading managed uv {MANAGED_UV_VERSION} ({platform})");
    let result = async {
        let (url, bytes) =
            download_archive_from_verified(&urls, MAX_MANAGED_TOOL_BYTES, |_, bytes| {
                let actual = format!("{:x}", Sha256::digest(bytes));
                if !actual.eq_ignore_ascii_case(artifact.sha256) {
                    anyhow::bail!(
                        "uv archive SHA-256 mismatch: expected {}, found {actual}",
                        artifact.sha256
                    );
                }
                Ok(())
            })
            .await?;
        extract_archive(&bytes, &url, &staging)?;
        let staged = staging
            .join(format!("uv-{}", artifact.target))
            .join(if cfg!(windows) { "uv.exe" } else { "uv" });
        let staged = if staged.is_file() {
            staged
        } else {
            find_staged_executable(&staging, if cfg!(windows) { "uv.exe" } else { "uv" })?
        };
        let version_root = base.join(MANAGED_UV_VERSION).join(&platform);
        tokio::fs::create_dir_all(&version_root).await?;
        let dest_dir = version_root.join(format!("uv-{}", artifact.target));
        tokio::fs::create_dir_all(&dest_dir).await?;
        let dest = dest_dir.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        tokio::fs::copy(&staged, &dest).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = tokio::fs::metadata(&dest).await?.permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&dest, permissions).await?;
        }
        let _ = tokio::fs::remove_dir_all(&staging).await;
        tracing::info!("Managed uv {MANAGED_UV_VERSION} installed");
        Ok(dest)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

pub(super) async fn ensure_managed_bun(managed_artifacts_dir: &Path) -> anyhow::Result<PathBuf> {
    let platform = current_platform();
    let artifact = managed_bun_artifact(&platform)
        .ok_or_else(|| anyhow::anyhow!("Bun is not supported on {platform}"))?;
    let final_executable = managed_bun_executable(managed_artifacts_dir)
        .ok_or_else(|| anyhow::anyhow!("could not resolve managed Bun path"))?;
    if tokio::fs::metadata(&final_executable).await.is_ok() {
        tracing::info!(
            "Using managed Bun {MANAGED_BUN_VERSION}: {}",
            final_executable.display()
        );
        return Ok(final_executable);
    }

    let base = managed_artifacts_dir.join("agent-tools").join("bun");
    tokio::fs::create_dir_all(&base).await?;
    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let urls = managed_bun_download_urls(&artifact);
    tracing::info!("Downloading managed Bun {MANAGED_BUN_VERSION} ({platform})");
    let result = async {
        let (url, bytes) =
            download_archive_from_verified(&urls, MAX_MANAGED_TOOL_BYTES, |_, bytes| {
                let actual = format!("{:x}", Sha256::digest(bytes));
                if !actual.eq_ignore_ascii_case(artifact.sha256) {
                    anyhow::bail!(
                        "Bun archive SHA-256 mismatch: expected {}, found {actual}",
                        artifact.sha256
                    );
                }
                Ok(())
            })
            .await?;
        extract_archive(&bytes, &url, &staging)?;
        let exe_name = if cfg!(windows) { "bun.exe" } else { "bun" };
        let staged = staging
            .join(format!("bun-{}", artifact.target))
            .join(exe_name);
        let staged = if staged.is_file() {
            staged
        } else {
            find_staged_executable(&staging, exe_name)?
        };
        let version_root = base.join(MANAGED_BUN_VERSION).join(&platform);
        tokio::fs::create_dir_all(&version_root).await?;
        let dest_dir = version_root.join(format!("bun-{}", artifact.target));
        tokio::fs::create_dir_all(&dest_dir).await?;
        let dest = dest_dir.join(exe_name);
        tokio::fs::copy(&staged, &dest).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = tokio::fs::metadata(&dest).await?.permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&dest, permissions).await?;
        }
        let _ = tokio::fs::remove_dir_all(&staging).await;
        tracing::info!("Managed Bun {MANAGED_BUN_VERSION} installed");
        Ok(dest)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

const NPM_LOCK_RETRY_BACKOFFS_MS: &[u64] = &[500, 1500];

pub(super) fn build_npm_global_install_command(
    npm: &Path,
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    node: Option<&NodeRuntime>,
    registry: &str,
) -> tokio::process::Command {
    let mut command = utils::process::new_hidden_tokio_command(npm, std::iter::empty::<&str>());
    if std::env::var_os("NODE_USE_ENV_PROXY").is_none() {
        command.env("NODE_USE_ENV_PROXY", "1");
    }
    if std::env::var_os("HERMES_NPM_AUTO_SETUP").is_none() {
        command.env("HERMES_NPM_AUTO_SETUP", "0");
    }
    command.env("npm_config_prefix", &user_env.npm_prefix);
    if let Some(runtime) = node {
        prepend_command_path(&mut command, &runtime.bin_dir);
    }
    command.args(npm_global_install_args_with_registry(
        &user_env.npm_prefix,
        &component.resolved_source,
        registry,
    ));
    command
}

pub(super) async fn run_npm_global_install<F>(
    npm: &Path,
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    node: Option<&NodeRuntime>,
    on_progress: &mut F,
) -> anyhow::Result<()>
where
    F: FnMut(u8, &str),
{
    let cmd_line = format!(
        "$ npm install -g --force --prefix {} {}",
        user_env.npm_prefix.display(),
        component.resolved_source
    );
    tracing::info!("{cmd_line}");
    on_progress(55, &cmd_line);
    let mut errors = Vec::new();
    for registry in utils::mirror::npm_registry_candidates() {
        let command = build_npm_global_install_command(npm, component, user_env, node, registry);
        match run_command_with_progress("npm install -g", command, 68, on_progress).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                let message = error.to_string();
                if npm_install_permission_denied(&message)
                    || npm_install_resource_busy(&message)
                    || npm_install_unsupported_node_engine(&message)
                {
                    return Err(error);
                }
                errors.push(format!("{registry}: {error}"));
            }
        }
    }
    anyhow::bail!("{}", errors.join("; "))
}

pub(super) fn cleanup_stale_npm_staging_dirs(npm_global_root: &Path, package: &str) -> usize {
    let mut parts = package.split('/');
    let (parent_dir, unscoped_name) = match (parts.next(), parts.next()) {
        (Some(scope), Some(name)) if scope.starts_with('@') && !name.is_empty() => {
            (npm_global_root.join("node_modules").join(scope), name)
        }
        (Some(name), None) if !name.is_empty() => (npm_global_root.join("node_modules"), name),
        _ => return 0,
    };
    let staging_prefix = format!(".{unscoped_name}-");
    let Ok(entries) = std::fs::read_dir(&parent_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(&staging_prefix) {
            continue;
        }
        let path = entry.path();
        let ok = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if ok {
            removed += 1;
        }
    }
    removed
}

fn dimo_managed_npm_prefix() -> PathBuf {
    utils::assets::host_data_dir()
        .join("agent-tools")
        .join("npm-prefix")
}

fn npm_install_is_lock_or_permission_error(message: &str) -> bool {
    npm_install_permission_denied(message) || npm_install_resource_busy(message)
}

fn format_npm_lock_error(error: &anyhow::Error, prefix: &Path) -> anyhow::Error {
    anyhow::anyhow!(
        "{error}\n\n目录 `{}` 存在文件锁定或权限拒绝（EPERM/EBUSY），已清理残留临时目录并重试仍失败。请关闭正在运行的相关 Agent、终端，或检查杀毒软件 / Windows Defender 实时扫描占用后重试。",
        prefix.display()
    )
}

pub(super) async fn install_npm<F>(
    component: &PlannedInstallComponent,
    user_env: &mut UserEnvironmentLayout,
    node: Option<&NodeRuntime>,
    on_progress: &mut F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(u8, &str),
{
    let npm = node
        .map(|runtime| runtime.npm.clone())
        .or(utils::shell::resolve_executable_path("npm").await)
        .ok_or_else(|| anyhow::anyhow!("npm was not found; install Node.js and npm first"))?;
    let package = npm_spec_name(&component.resolved_source);
    if let Err(mut last_error) =
        run_npm_global_install(&npm, component, user_env, node, on_progress).await
    {
        let mut message = last_error.to_string();
        if !npm_install_is_lock_or_permission_error(&message) {
            return Err(last_error);
        }

        let mut installed = false;
        let fallback = user_env.user_npm_prefix();
        if fallback != user_env.npm_prefix {
            let reason = if npm_install_resource_busy(&message) {
                "target directory is busy/locked (EBUSY)"
            } else {
                "permission denied (EPERM/EACCES)"
            };
            tracing::info!("{reason}, retrying with user prefix...");
            on_progress(
                60,
                &format!(
                    "[npm] {reason} on global prefix, retrying with {}",
                    fallback.display()
                ),
            );
            *user_env = user_env.clone().with_npm_prefix(fallback);
            prepare_user_environment(user_env).await?;
            match run_npm_global_install(&npm, component, user_env, node, on_progress).await {
                Ok(()) => installed = true,
                Err(error) => {
                    message = error.to_string();
                    last_error = error;
                    if !npm_install_is_lock_or_permission_error(&message) {
                        return Err(last_error);
                    }
                }
            }
        }

        if !installed {
            for (index, delay_ms) in NPM_LOCK_RETRY_BACKOFFS_MS.iter().copied().enumerate() {
                let attempt = index + 1;
                let removed = cleanup_stale_npm_staging_dirs(&user_env.npm_global_root(), &package);
                tracing::info!(
                    attempt,
                    delay_ms,
                    removed_staging_dirs = removed,
                    prefix = %user_env.npm_prefix.display(),
                    "npm install hit EPERM/EBUSY, retrying after backoff"
                );
                on_progress(
                    61 + attempt as u8,
                    &format!(
                        "[npm] file lock or permission error on {}, retrying ({attempt}/{})...",
                        user_env.npm_prefix.display(),
                        NPM_LOCK_RETRY_BACKOFFS_MS.len()
                    ),
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                match run_npm_global_install(&npm, component, user_env, node, on_progress).await {
                    Ok(()) => {
                        installed = true;
                        break;
                    }
                    Err(error) => {
                        message = error.to_string();
                        last_error = error;
                        if !npm_install_is_lock_or_permission_error(&message) {
                            return Err(last_error);
                        }
                    }
                }
            }
        }

        if !installed {
            let managed_prefix = dimo_managed_npm_prefix();
            if managed_prefix != user_env.npm_prefix {
                tracing::info!(
                    managed_prefix = %managed_prefix.display(),
                    "retrying npm install with Dimo-managed npm prefix after repeated EPERM/EBUSY"
                );
                on_progress(
                    65,
                    &format!(
                        "[npm] retrying with Dimo-managed prefix {}",
                        managed_prefix.display()
                    ),
                );
                let managed_env = user_env.clone().with_npm_prefix(managed_prefix);
                if prepare_user_environment(&managed_env).await.is_ok() {
                    cleanup_stale_npm_staging_dirs(&managed_env.npm_global_root(), &package);
                    match run_npm_global_install(&npm, component, &managed_env, node, on_progress)
                        .await
                    {
                        Ok(()) => {
                            *user_env = managed_env;
                            installed = true;
                        }
                        Err(error) => {
                            let managed_msg = error.to_string();
                            if !npm_install_is_lock_or_permission_error(&managed_msg) {
                                return Err(error);
                            }
                            last_error = error;
                        }
                    }
                }
            }
        }

        if !installed {
            return Err(format_npm_lock_error(&last_error, &user_env.npm_prefix));
        }
    }
    let resolved_bin = command_is_placeholder(&component.command)
        .then(|| resolve_npm_package_bin_name(&user_env.npm_prefix, &package));
    let name = if let Some(bin_name) = resolved_bin.as_deref() {
        bin_name
    } else {
        Path::new(&component.command)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&component.command)
    };
    let bin = resolve_npm_shim(&user_env.npm_bin, name).ok_or_else(|| {
        anyhow::anyhow!(
            "npm install did not produce `{}` under {}",
            name,
            user_env.npm_bin.display()
        )
    })?;
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(bin).await?,
    ))
}

pub(super) fn resolve_npm_package_bin_name(npm_prefix: &Path, package: &str) -> String {
    let unscoped = package.rsplit('/').next().unwrap_or(package);
    let mut pkg_rel = PathBuf::from("node_modules");
    for segment in package.split('/') {
        if !segment.is_empty() {
            pkg_rel.push(segment);
        }
    }
    pkg_rel.push("package.json");
    let candidates = [
        npm_prefix.join(&pkg_rel),
        npm_prefix.join("lib").join(&pkg_rel),
    ];
    for package_json in candidates {
        let Ok(bytes) = std::fs::read(&package_json) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        match parsed.get("bin") {
            Some(serde_json::Value::String(_)) => {
                if let Some(name) = parsed
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|value| value.rsplit('/').next().unwrap_or(value).trim())
                    .filter(|value| !value.is_empty())
                {
                    return name.to_string();
                }
                return unscoped.to_string();
            }
            Some(serde_json::Value::Object(map)) if !map.is_empty() => {
                if map.contains_key(unscoped) {
                    return unscoped.to_string();
                }
                if let Some(first) = map.keys().next() {
                    return first.clone();
                }
            }
            _ => {}
        }
    }
    unscoped.to_string()
}

pub(super) fn command_is_placeholder(command: &str) -> bool {
    command.is_empty() || command == "npm"
}

pub(super) async fn live_npm_global_prefix(node: Option<&NodeRuntime>) -> Option<PathBuf> {
    let npm = if let Some(runtime) = node {
        runtime.npm.clone()
    } else {
        utils::shell::resolve_executable_path(if cfg!(windows) { "npm.cmd" } else { "npm" }).await?
    };
    let mut command = utils::process::new_hidden_tokio_command(&npm, std::iter::empty::<&str>());
    if let Some(runtime) = node {
        prepend_command_path(&mut command, &runtime.bin_dir);
    }
    command.arg("prefix").arg("-g");
    let output = utils::process::run_command_output_with_timeout(
        &mut command,
        std::time::Duration::from_secs(3),
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let decoded = utils::process::decode_process_output(&output.stdout);
    let prefix = decoded.lines().next()?.trim().to_string();
    if prefix.is_empty() {
        None
    } else {
        Some(PathBuf::from(prefix))
    }
}

const MAX_AGENT_BINARY_BYTES: usize = 768 * 1024 * 1024;

pub(super) async fn install_uv<F>(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    uv: Option<&Path>,
    on_progress: &mut F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(u8, &str),
{
    let uv = uv
        .map(Path::to_path_buf)
        .or(utils::shell::resolve_executable_path("uv").await)
        .ok_or_else(|| anyhow::anyhow!("uv was not found; install uv first"))?;
    let cmd_line = format!(
        "$ uv tool install --force --no-config {}",
        component.resolved_source
    );
    tracing::info!("$ uv tool install {}", component.resolved_source);
    on_progress(55, &cmd_line);
    let mut errors = Vec::new();
    let mut installed = false;
    for (pypi_index, python_mirror) in utils::mirror::uv_install_mirror_candidates() {
        let mut command = utils::process::new_hidden_tokio_command(&uv, std::iter::empty::<&str>());
        command
            .arg("tool")
            .arg("install")
            .arg("--force")
            .arg("--no-config")
            .arg("--default-index")
            .arg(pypi_index);
        if component.resolved_source.starts_with("hermes-agent[") {
            command.arg("--python").arg("3.13");
        }
        command
            .arg(&component.resolved_source)
            .env("UV_TOOL_DIR", &user_env.uv_tool_dir)
            .env("UV_TOOL_BIN_DIR", &user_env.uv_tool_bin)
            .env("UV_PYTHON_INSTALL_DIR", &user_env.uv_python_dir)
            .env("UV_CACHE_DIR", &user_env.uv_cache_dir);
        if let Some(mirror) = python_mirror {
            command.env("UV_PYTHON_INSTALL_MIRROR", mirror);
        } else {
            command.env_remove("UV_PYTHON_INSTALL_MIRROR");
        }
        match run_command_with_progress("uv tool install", command, 68, on_progress).await {
            Ok(()) => {
                installed = true;
                break;
            }
            Err(error) => {
                errors.push(format!("{pypi_index}: {error}"));
            }
        }
    }
    if !installed {
        anyhow::bail!("{}", errors.join("; "));
    }
    let name = Path::new(&component.command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(component.command.as_str());
    let bin = if cfg!(windows) {
        user_env.uv_tool_bin.join(format!("{name}.exe"))
    } else {
        user_env.uv_tool_bin.join(name)
    };
    if tokio::fs::metadata(&bin).await.is_err() {
        anyhow::bail!("uv tool install did not produce `{}`", bin.display());
    }
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(bin).await?,
    ))
}

pub(super) async fn install_binary<F>(
    agent_id: &AgentId,
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    on_progress: &mut F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(u8, &str),
{
    if is_kiro_official_installer(agent_id, &component.resolved_source) {
        on_progress(55, &format!("GET {}", component.resolved_source));
        return install_kiro_from_official_installer(component, user_env).await;
    }
    if is_muse_official_installer(agent_id, &component.resolved_source) {
        on_progress(55, &format!("GET {}", component.resolved_source));
        return install_muse_from_official_installer(component, user_env).await;
    }
    tracing::info!(
        "Downloading {} ({})",
        component.component_id,
        component.version
    );
    let urls = utils::mirror::download_url_candidates(&component.resolved_source);
    on_progress(
        55,
        &format!(
            "GET {}",
            urls.first()
                .map(String::as_str)
                .unwrap_or(&component.resolved_source)
        ),
    );
    let (downloaded_url, bytes) =
        download_archive_from_verified(&urls, MAX_AGENT_BINARY_BYTES, |_, bytes| {
            if let agents::ArtifactTrust::ExpectedSha256 { .. } = &component.trust {
                verify_artifact_bytes(&component.trust, bytes, None)
                    .map_err(|error| anyhow::anyhow!("{error}"))?;
            }
            Ok(())
        })
        .await?;
    on_progress(
        65,
        &format!(
            "[download] {} ({} bytes)",
            component.component_id,
            bytes.len()
        ),
    );
    let staging = utils::path::unique_dimo_scratch_dir("agent")?;
    let extract_result = extract_archive(&bytes, &downloaded_url, &staging);
    let staged =
        match extract_result.and_then(|_| find_staged_executable(&staging, &component.command)) {
            Ok(path) => path,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(error);
            }
        };
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    let destination = user_bin_destination(&user_env.user_bin, &component.command, &staged);
    let siblings = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .map(|profile| profile.binary_required_siblings(cfg!(windows)))
        .unwrap_or(&[]);
    let install_result =
        install_staged_binary_and_siblings(&staged, &destination, &user_env.user_bin, siblings)
            .await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    install_result?;
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(destination).await?,
    ))
}

pub(super) async fn install_staged_binary_and_siblings(
    staged: &Path,
    destination: &Path,
    user_bin: &Path,
    siblings: &[&str],
) -> anyhow::Result<()> {
    replace_executable_file(staged, destination).await?;
    if let Some(staged_dir) = staged.parent() {
        for sibling in siblings {
            let name = Path::new(sibling)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(sibling);
            let source = staged_dir.join(name);
            if !source.is_file() {
                anyhow::bail!("extracted archive is missing required sibling `{name}`");
            }
            replace_executable_file(&source, &user_bin.join(name)).await?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(destination).await?.permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(destination, permissions).await?;
    }
    Ok(())
}

/// Replaces `destination` with `source` in the same directory so an active or
/// lingering process holding `destination` open (Windows `ERROR_SHARING_VIOLATION`
/// / `os error 32` or Unix `ETXTBSY`) does not block binary ACP updates.
pub(super) async fn replace_executable_file(
    source: &Path,
    destination: &Path,
) -> anyhow::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow::anyhow!("destination `{}` has no parent", destination.display()))?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            anyhow::anyhow!("destination `{}` has no file name", destination.display())
        })?;
    cleanup_stale_replaced_files(parent, file_name).await;

    let temp_new = parent.join(format!(".{file_name}.new-{}", Uuid::new_v4()));
    tokio::fs::copy(source, &temp_new).await?;

    if tokio::fs::rename(&temp_new, destination).await.is_ok() {
        return Ok(());
    }

    let aside = parent.join(format!(".{file_name}.old-{}", Uuid::new_v4()));
    let moved_aside = tokio::fs::rename(destination, &aside).await.is_ok();
    match tokio::fs::rename(&temp_new, destination).await {
        Ok(()) => {
            if moved_aside {
                let _ = tokio::fs::remove_file(&aside).await;
            }
            Ok(())
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temp_new).await;
            if moved_aside {
                let _ = tokio::fs::rename(&aside, destination).await;
            }
            Err(error.into())
        }
    }
}

pub(super) async fn cleanup_stale_replaced_files(parent: &Path, file_name: &str) {
    let old_prefix = format!(".{file_name}.old-");
    let new_prefix = format!(".{file_name}.new-");
    let Ok(mut entries) = tokio::fs::read_dir(parent).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with(&old_prefix) || name.starts_with(&new_prefix) {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

pub(super) fn is_kiro_official_installer(agent_id: &AgentId, source: &str) -> bool {
    let lower = source_path(source).to_ascii_lowercase();
    agent_id.as_str() == "kiro"
        && (lower.ends_with(".ps1") || lower.ends_with(".msi") || lower.ends_with("/install"))
}

pub(super) fn is_muse_official_installer(agent_id: &AgentId, source: &str) -> bool {
    let lower = source_path(source).to_ascii_lowercase();
    agent_id.as_str() == "muse_code"
        && (lower.ends_with("/install.sh") || lower.ends_with("/install.ps1"))
}

pub(super) async fn install_muse_from_official_installer(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<PathBuf> {
    let staging = utils::path::unique_dimo_scratch_dir("muse")?;
    let result = install_muse_in_staging(component, user_env, &staging).await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    result
}

async fn install_muse_in_staging(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    staging: &Path,
) -> anyhow::Result<PathBuf> {
    tracing::info!(
        "Running Muse Code official installer: {}",
        component.resolved_source
    );
    let urls = utils::mirror::download_url_candidates(&component.resolved_source);
    let (_, script_bytes) = download_archive_from(&urls, MAX_MANAGED_TOOL_BYTES).await?;
    tokio::fs::create_dir_all(&user_env.user_bin).await?;

    if cfg!(windows) {
        let script_path = staging.join("install.ps1");
        tokio::fs::write(&script_path, &script_bytes).await?;
        let mut cmd = utils::process::new_hidden_tokio_command(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ],
        );
        cmd.arg(&script_path)
            .env("MUSE_INSTALL_DIR", &user_env.user_bin)
            .env("MUSE_NO_MODIFY_PATH", "1")
            .env("MUSE_NO_AUTO_UPDATE", "1")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        tokio::time::timeout(
            std::time::Duration::from_secs(240),
            run_command("powershell muse install.ps1", cmd),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Muse Code official installer timed out"))??;
    } else {
        let script_path = staging.join("install.sh");
        tokio::fs::write(&script_path, &script_bytes).await?;
        let mut cmd = utils::process::new_hidden_tokio_command("sh", std::iter::empty::<&str>());
        cmd.arg(&script_path)
            .env("MUSE_INSTALL_DIR", &user_env.user_bin)
            .env("MUSE_NO_MODIFY_PATH", "1")
            .env("MUSE_NO_AUTO_UPDATE", "1")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        tokio::time::timeout(
            std::time::Duration::from_secs(240),
            run_command("sh muse install.sh", cmd),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Muse Code official installer timed out"))??;
    }

    resolve_installed_muse_binary(user_env)
        .await
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Muse Code official installer completed, but `muse` was not found in {} or PATH",
                user_env.user_bin.display()
            )
        })
}

async fn resolve_installed_muse_binary(user_env: &UserEnvironmentLayout) -> Option<PathBuf> {
    let _ = utils::shell::refresh_process_path_after_install().await;
    let mut candidates = Vec::new();
    if cfg!(windows) {
        candidates.push(user_env.user_bin.join("muse.exe"));
        candidates.push(user_env.user_bin.join("muse.cmd"));
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            let dir = local_app_data.join("Programs").join("muse");
            candidates.push(dir.join("muse.exe"));
            candidates.push(dir.join("muse.cmd"));
        }
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local").join("bin").join("muse.exe"));
            candidates.push(home.join(".local").join("bin").join("muse.cmd"));
        }
    } else {
        candidates.push(user_env.user_bin.join("muse"));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local").join("bin").join("muse"));
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            if let Some(parent) = candidate.parent() {
                utils::shell::expose_user_bin_to_process_path(parent);
            }
            if let Ok(canon) = tokio::fs::canonicalize(&candidate).await {
                return Some(utils::process::prefer_direct_spawn_executable(canon));
            }
            return Some(candidate);
        }
    }
    if let Some(found) = utils::shell::resolve_executable_path("muse").await {
        return Some(found);
    }
    None
}

pub(super) fn sanitize_kiro_powershell_script(script: &str) -> String {
    script
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("Read-Host") {
                "# Read-Host disabled for unattended install"
            } else if trimmed.starts_with("Remove-Item") && trimmed.contains("$tempDir") {
                "# Preserve downloaded MSI in staging for fallback extraction"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

pub(super) async fn install_kiro_from_official_installer(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<PathBuf> {
    let staging = utils::path::unique_dimo_scratch_dir("kiro")?;
    let result = if cfg!(windows) {
        install_kiro_windows_with_fallback(component, user_env, &staging).await
    } else {
        install_kiro_unix_installer(component, user_env, &staging).await
    };
    let _ = tokio::fs::remove_dir_all(&staging).await;
    result
}

pub(super) async fn resolve_installed_kiro_binary(
    user_env: &UserEnvironmentLayout,
) -> Option<PathBuf> {
    let _ = utils::shell::refresh_process_path_after_install().await;
    if cfg!(windows) {
        let mut candidates = Vec::new();
        for env_key in ["ProgramFiles", "ProgramW6432"] {
            if let Some(root) = std::env::var_os(env_key).map(PathBuf::from) {
                candidates.push(root.join("Kiro-Cli").join("kiro-cli.exe"));
            }
        }
        candidates.push(PathBuf::from(r"C:\Program Files\Kiro-Cli\kiro-cli.exe"));
        candidates.push(user_env.user_bin.join("kiro-cli.exe"));
        for candidate in candidates {
            if candidate.is_file() {
                if let Some(parent) = candidate.parent() {
                    utils::shell::expose_user_bin_to_process_path(parent);
                }
                if let Ok(canon) = tokio::fs::canonicalize(&candidate).await {
                    return Some(utils::process::prefer_direct_spawn_executable(canon));
                }
                return Some(candidate);
            }
        }
    } else {
        let candidate = user_env.user_bin.join("kiro-cli");
        if candidate.is_file()
            && let Ok(canon) = tokio::fs::canonicalize(&candidate).await
        {
            return Some(utils::process::prefer_direct_spawn_executable(canon));
        }
    }
    if let Some(resolved) = utils::shell::resolve_executable_path("kiro-cli").await
        && let Ok(canon) = tokio::fs::canonicalize(&resolved).await
    {
        return Some(utils::process::prefer_direct_spawn_executable(canon));
    }
    None
}

pub(super) async fn install_kiro_windows_with_fallback(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    staging: &Path,
) -> anyhow::Result<PathBuf> {
    // 1. Try the official https://cli.kiro.dev/install.ps1 script with PowerShell
    //    ExecutionPolicy Bypass and non-interactive sanitization.
    if source_path(&component.resolved_source)
        .to_ascii_lowercase()
        .ends_with(".ps1")
    {
        tracing::info!(
            "Running Kiro official PowerShell installer: {}",
            component.resolved_source
        );
        let ps1_urls = utils::mirror::download_url_candidates(&component.resolved_source);
        if let Ok((_, script_bytes)) =
            download_archive_from(&ps1_urls, MAX_MANAGED_TOOL_BYTES).await
            && let Ok(script_text) = String::from_utf8(script_bytes)
        {
            let sanitized = sanitize_kiro_powershell_script(&script_text);
            let script_path = staging.join("install.ps1");
            if tokio::fs::write(&script_path, sanitized).await.is_ok() {
                let mut cmd = utils::process::new_hidden_tokio_command(
                    "powershell.exe",
                    [
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                    ],
                );
                cmd.arg(&script_path)
                    .env("TEMP", staging)
                    .env("TMP", staging)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true);
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(180),
                    run_command("powershell install.ps1", cmd),
                )
                .await;
                if let Some(installed) = resolve_installed_kiro_binary(user_env).await {
                    return Ok(installed);
                }
            }
        }
    }

    // 2. Fallback: Use MSI already downloaded by install.ps1 in staging, or download
    //    the official Windows MSI from Kiro's manifest.json and verify SHA-256.
    let msi_from_ps1 = staging.join("kiro-cli-installer").join("kiro-cli.msi");
    let msi_path = if msi_from_ps1.is_file() {
        msi_from_ps1
    } else {
        download_kiro_windows_msi(component, staging).await?
    };

    // 2a. Try standard silent MSI install (`msiexec /i <msi> /quiet /norestart`).
    let mut msi_install = utils::process::new_hidden_tokio_command("msiexec.exe", ["/i"]);
    msi_install
        .arg(&msi_path)
        .arg("/quiet")
        .arg("/norestart")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        run_command("msiexec /i", msi_install),
    )
    .await;
    if let Some(installed) = resolve_installed_kiro_binary(user_env).await {
        return Ok(installed);
    }

    // 2b. Non-admin permission fallback: `msiexec /a <msi> /qn TARGETDIR=<extract_dir>`
    //     unpacks the MSI into user-writable storage without requiring Administrator privileges.
    let extract_dir = staging.join("extracted");
    tokio::fs::create_dir_all(&extract_dir).await?;
    let target_dir_arg = format!("TARGETDIR={}", extract_dir.display());
    let mut msi_extract = utils::process::new_hidden_tokio_command("msiexec.exe", ["/a"]);
    msi_extract
        .arg(&msi_path)
        .arg("/qn")
        .arg(&target_dir_arg)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        run_command("msiexec /a", msi_extract),
    )
    .await
    .map_err(|_| anyhow::anyhow!("msiexec administrative extraction timed out"))??;

    let staged_exe = find_staged_executable(&extract_dir, "kiro-cli.exe")?;
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    if let Some(staged_dir) = staged_exe.parent() {
        for entry in std::fs::read_dir(staged_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file()
                && let Some(name) = path.file_name()
            {
                replace_executable_file(&path, &user_env.user_bin.join(name)).await?;
            }
        }
    } else {
        replace_executable_file(&staged_exe, &user_env.user_bin.join("kiro-cli.exe")).await?;
    }
    utils::shell::expose_user_bin_to_process_path(&user_env.user_bin);
    let dest = user_env.user_bin.join("kiro-cli.exe");
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(dest).await?,
    ))
}

pub(super) async fn download_kiro_windows_msi(
    component: &PlannedInstallComponent,
    staging: &Path,
) -> anyhow::Result<PathBuf> {
    let (msi_url, expected_sha256) = if source_path(&component.resolved_source)
        .to_ascii_lowercase()
        .ends_with(".msi")
    {
        (component.resolved_source.clone(), None)
    } else {
        const KIRO_MANIFEST_URL: &str =
            "https://prod.download.cli.kiro.dev/stable/latest/manifest.json";
        let manifest_urls = utils::mirror::download_url_candidates(KIRO_MANIFEST_URL);
        let (_, manifest_bytes) =
            download_archive_from_verified(&manifest_urls, MAX_MANAGED_TOOL_BYTES, |_, bytes| {
                serde_json::from_slice::<serde_json::Value>(bytes)?;
                Ok(())
            })
            .await?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)?;
        let pkg = manifest
            .get("packages")
            .and_then(serde_json::Value::as_array)
            .and_then(|pkgs| {
                pkgs.iter().find(|p| {
                    p.get("os").and_then(serde_json::Value::as_str) == Some("windows")
                        && p.get("fileType").and_then(serde_json::Value::as_str) == Some("msi")
                        && p.get("architecture").and_then(serde_json::Value::as_str)
                            == Some("x86_64")
                })
            })
            .ok_or_else(|| {
                anyhow::anyhow!("Kiro manifest.json does not contain a Windows x86_64 MSI package")
            })?;
        let download = pkg
            .get("download")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Kiro MSI package is missing download path"))?;
        let sha256 = pkg
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        (
            format!("https://prod.download.cli.kiro.dev/stable/{download}"),
            sha256,
        )
    };
    tracing::info!("Downloading Kiro Windows MSI: {msi_url}");
    let msi_urls = utils::mirror::download_url_candidates(&msi_url);
    let (_, bytes) =
        download_archive_from_verified(&msi_urls, MAX_AGENT_BINARY_BYTES, |_, bytes| {
            if let agents::ArtifactTrust::ExpectedSha256 { .. } = &component.trust {
                verify_artifact_bytes(&component.trust, bytes, None)
                    .map_err(|error| anyhow::anyhow!("{error}"))?;
            }
            if let Some(expected) = expected_sha256.as_deref() {
                let actual = format!("{:x}", Sha256::digest(bytes));
                if !actual.eq_ignore_ascii_case(expected) {
                    anyhow::bail!("Kiro MSI SHA-256 mismatch: expected {expected}, found {actual}");
                }
            }
            Ok(())
        })
        .await?;
    let msi_path = staging.join("kiro-cli.msi");
    tokio::fs::write(&msi_path, &bytes).await?;
    Ok(msi_path)
}

pub(super) async fn install_kiro_unix_installer(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    staging: &Path,
) -> anyhow::Result<PathBuf> {
    tracing::info!(
        "Running Kiro official installer: {}",
        component.resolved_source
    );
    let script_urls = utils::mirror::download_url_candidates(&component.resolved_source);
    let (_, script_bytes) = download_archive_from(&script_urls, MAX_MANAGED_TOOL_BYTES).await?;
    let script_path = staging.join("install.sh");
    tokio::fs::write(&script_path, &script_bytes).await?;
    let mut cmd = utils::process::new_hidden_tokio_command("bash", [&script_path]);
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(
        std::time::Duration::from_secs(180),
        run_command("bash install.sh", cmd),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Kiro installer script timed out"))??;
    resolve_installed_kiro_binary(user_env)
        .await
        .ok_or_else(|| anyhow::anyhow!("Kiro installer finished but `kiro-cli` was not found"))
}

pub(super) fn user_bin_destination(user_bin: &Path, command: &str, staged: &Path) -> PathBuf {
    let name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    if cfg!(windows) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".exe") || lower.ends_with(".bat") {
            user_bin.join(name)
        } else if staged
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
        {
            user_bin.join(format!("{name}.cmd"))
        } else {
            user_bin.join(format!("{name}.exe"))
        }
    } else {
        user_bin.join(name)
    }
}

pub(super) fn extract_archive(
    bytes: &[u8],
    source: &str,
    destination: &Path,
) -> anyhow::Result<()> {
    if source_path(source).to_ascii_lowercase().ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        archive.extract(destination)?;
        return Ok(());
    }
    if is_single_file_gzip(source, bytes) {
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(bytes).read_to_end(&mut decoded)?;
        if looks_like_tar(&decoded) {
            return extract_tar(bytes, destination);
        }
        std::fs::create_dir_all(destination)?;
        std::fs::write(destination.join(gzip_member_name(source)), &decoded)?;
        return Ok(());
    }
    if !looks_like_tar(bytes) && is_standalone_executable(bytes) {
        std::fs::create_dir_all(destination)?;
        std::fs::write(destination.join(standalone_binary_name(source)), bytes)?;
        return Ok(());
    }
    extract_tar(bytes, destination)
}

pub(super) fn source_path(source: &str) -> &str {
    source.split(['?', '#']).next().unwrap_or(source)
}

pub(super) fn is_single_file_gzip(source: &str, bytes: &[u8]) -> bool {
    let path = source_path(source).to_ascii_lowercase();
    path.ends_with(".gz")
        && !path.ends_with(".tar.gz")
        && !path.ends_with(".tgz")
        && bytes.starts_with(&[0x1f, 0x8b])
}

pub(super) fn looks_like_tar(bytes: &[u8]) -> bool {
    bytes.len() >= 262 && &bytes[257..262] == b"ustar"
}

pub(super) fn is_standalone_executable(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xce])
        || bytes.starts_with(&[0xce, 0xfa, 0xed, 0xfe])
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
        || bytes.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
        || bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
        || bytes.starts_with(&[0xbe, 0xba, 0xfe, 0xca])
}

pub(super) fn standalone_binary_name(source: &str) -> String {
    if let Ok(parsed) = reqwest::Url::parse(source)
        && let Some((_, file_param)) = parsed.query_pairs().find(|(key, _)| key == "file")
        && let Some(name) = Path::new(file_param.as_ref())
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty() && *value != "." && *value != "..")
    {
        return name.to_string();
    }
    let path = source_path(source);
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("payload")
        .to_string()
}

pub(super) fn gzip_member_name(source: &str) -> String {
    let path = source_path(source);
    let file = path.rsplit(['/', '\\']).next().unwrap_or("payload");
    let name = file
        .to_ascii_lowercase()
        .ends_with(".gz")
        .then(|| &file[..file.len() - 3])
        .filter(|name| !name.is_empty())
        .unwrap_or("payload");
    name.to_string()
}

pub(super) fn extract_tar(bytes: &[u8], destination: &Path) -> anyhow::Result<()> {
    let archive = destination.join("download.archive");
    std::fs::write(&archive, bytes)?;
    let mut command = std::process::Command::new("tar");
    utils::process::configure_std_command_no_window(&mut command);
    let status = command
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(destination)
        .status()?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() {
        anyhow::bail!("tar extract failed with {status}");
    }
    Ok(())
}

pub(super) fn find_staged_executable(root: &Path, command: &str) -> anyhow::Result<PathBuf> {
    let relative = PathBuf::from(command);
    let direct = root.join(&relative);
    if direct.is_file() {
        return Ok(direct);
    }
    let file_name = relative
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("binary command `{command}` is not a file name"))?;
    let mut named = None;
    let mut only_file = None;
    let mut file_count = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some("download.archive") {
                continue;
            }
            file_count += 1;
            if path.file_name() == Some(file_name) {
                named = Some(path.clone());
            }
            only_file = Some(path);
        }
    }
    if let Some(path) = named {
        return Ok(path);
    }
    if file_count == 1 {
        return only_file.ok_or_else(|| anyhow::anyhow!("extracted archive is empty"));
    }
    anyhow::bail!("extracted archive does not contain `{command}`")
}

pub(super) async fn prepare_user_environment(
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    tokio::fs::create_dir_all(&user_env.npm_bin).await?;
    tokio::fs::create_dir_all(&user_env.uv_tool_dir).await?;
    for directory in user_env.path_entries() {
        utils::shell::expose_user_bin_to_process_path(&directory);
    }
    let _ = utils::shell::refresh_process_path_after_install().await;
    Ok(())
}

pub(super) async fn verify_handshake(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
) -> anyhow::Result<()> {
    if is_native_engine_profile(agent_id) {
        if agents::launch_program_is_legacy_acp_shim(agent_id, &lock.absolute_acp_program) {
            anyhow::bail!(
                "legacy ACP shim `{}` cannot be used for native engine `{agent_id}`",
                lock.absolute_acp_program.display()
            );
        }
        let version = probe_version(&lock.absolute_acp_program, &["--version"])
            .await
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "native engine `{}` failed `--version` health check",
                    lock.absolute_acp_program.display()
                )
            })?;
        if version.trim().is_empty() {
            anyhow::bail!(
                "native engine `{}` returned an empty version string",
                lock.absolute_acp_program.display()
            );
        }
        return Ok(());
    }
    let (event_tx, _event_rx) = agents::manager::manager_event_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: lock.clone(),
            workspace_id: Uuid::nil(),
            working_dir: working_dir.to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    let readiness = tokio::time::timeout(std::time::Duration::from_secs(30), ready).await;
    let _ = manager.disconnect(connection_id).await;
    readiness
        .map_err(|_| anyhow::anyhow!("ACP handshake timed out"))?
        .map_err(|_| anyhow::anyhow!("ACP process exited before initialize"))??;
    Ok(())
}

pub(super) async fn persist_lock(
    pool: &SqlitePool,
    plan: &ResolvedInstallPlan,
    installation: &InstalledPlan,
) -> anyhow::Result<()> {
    let lock_id = Uuid::new_v4();
    let source = match &plan.source {
        LockedInstallSource::BuiltInProfile => serde_json::json!({ "kind": "built_in_profile" }),
        LockedInstallSource::BuiltInProfileWithRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "built_in_profile_with_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::OfficialRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "official_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::UserDefinition { definition_sha256 } => serde_json::json!({
            "kind": "user_definition",
            "definition_sha256": definition_sha256,
        }),
    };
    let resolved_json = serde_json::json!({
        "source": source,
        "frozen_plan": plan,
        "absolute_acp_program": installation.launch_lock.absolute_acp_program,
        "args": installation.launch_lock.args,
        "env": installation.launch_lock.env,
        "runtime_version": installation.launch_lock.runtime_version,
        "acp_version": installation.launch_lock.acp_version,
    })
    .to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(lock_id.to_string())
    .bind(plan.agent_id.as_str())
    .bind(plan.registry_bound_version())
    .bind(&plan.platform)
    .bind(
        plan.components
            .first()
            .map(|component| format!("{:?}", component.distribution_kind).to_lowercase())
            .unwrap_or_else(|| "unknown".to_string()),
    )
    .bind(resolved_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    for component in &installation.components {
        sqlx::query(
            r#"INSERT INTO agent_install_component
               (id, lock_id, component_kind, absolute_path, version, sha256,
                trust_state, ownership, shared_resource_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(lock_id.to_string())
        .bind(&component.kind)
        .bind(component.absolute_path.display().to_string())
        .bind(&component.version)
        .bind(&component.sha256)
        .bind("user_environment")
        .bind("external")
        .bind(Option::<String>::None)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, 'external', 'ready', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             ownership = excluded.ownership,
             rollback_lock_id = agent_installation.current_lock_id,
             current_lock_id = excluded.current_lock_id,
             lifecycle = 'ready',
             active_operation = NULL,
             active_operation_id = NULL,
             updated_at = CURRENT_TIMESTAMP"#,
    )
    .bind(plan.agent_id.as_str())
    .bind(lock_id.to_string())
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"UPDATE agent_diagnostic
           SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE agent_id = ?
             AND severity = 'error'
             AND read_at IS NULL"#,
    )
    .bind(plan.agent_id.as_str())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn probe_version(executable: &Path, version_args: &[&str]) -> Option<String> {
    probe_version_with_path(executable, version_args, None).await
}

pub(super) async fn probe_version_with_path(
    executable: &Path,
    version_args: &[&str],
    extra_bin_dir: Option<&Path>,
) -> Option<String> {
    if version_args.is_empty() {
        return None;
    }
    let mut command =
        utils::process::new_hidden_tokio_command(executable, version_args.iter().copied());
    if std::env::var_os("HERMES_NPM_AUTO_SETUP").is_none() {
        command.env("HERMES_NPM_AUTO_SETUP", "0");
    }
    if let Some(dir) = extra_bin_dir {
        prepend_command_path(&mut command, dir);
    }
    let output = utils::process::run_command_output_with_timeout(
        &mut command,
        std::time::Duration::from_secs(5),
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = utils::process::decode_process_output(&output.stdout);
    let stderr = utils::process::decode_process_output(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

pub(super) async fn file_sha256(path: &Path) -> anyhow::Result<String> {
    let bytes = tokio::fs::read(path).await?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

const INSTALL_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

pub(super) async fn run_command(
    label: &str,
    mut command: tokio::process::Command,
) -> anyhow::Result<()> {
    command.kill_on_drop(true);
    let output =
        utils::process::run_command_output_with_timeout(&mut command, INSTALL_COMMAND_TIMEOUT)
            .await
            .map_err(|error| anyhow::anyhow!("{label} failed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("exit status {}", output.status));
    anyhow::bail!("{label} failed: {detail}")
}

pub(super) async fn run_command_with_progress<F>(
    label: &str,
    mut command: tokio::process::Command,
    percent: u8,
    on_progress: &mut F,
) -> anyhow::Result<()>
where
    F: FnMut(u8, &str),
{
    command.kill_on_drop(true);
    let output =
        utils::process::run_command_output_with_timeout(&mut command, INSTALL_COMMAND_TIMEOUT)
            .await
            .map_err(|error| anyhow::anyhow!("{label} failed: {error}"))?;
    let stdout = utils::process::decode_process_output(&output.stdout);
    let stderr = utils::process::decode_process_output(&output.stderr);
    for line in stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(40)
    {
        on_progress(percent, line);
    }
    if output.status.success() {
        return Ok(());
    }
    let detail = utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("exit status {}", output.status));
    anyhow::bail!("{label} failed: {detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_global_install_command_disables_hermes_auto_setup() {
        let temp = tempfile::tempdir().unwrap();
        let user_env = UserEnvironmentLayout::for_home(temp.path());
        let component = PlannedInstallComponent {
            component_id: "combined_runtime".to_string(),
            distribution_kind: PlannedDistributionKind::Npx,
            version: "0.22.2".to_string(),
            resolved_source: "hermes-agent@0.22.2".to_string(),
            command: "hermes".to_string(),
            args: vec!["acp".to_string()],
            env: BTreeMap::new(),
            trust: agents::ArtifactTrust::Tofu,
        };

        let command = build_npm_global_install_command(
            Path::new("npm"),
            &component,
            &user_env,
            None,
            "https://registry.npmjs.org",
        );

        let envs: Vec<(String, Option<String>)> = command
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|val| val.to_string_lossy().into_owned()),
                )
            })
            .collect();
        if std::env::var_os("HERMES_NPM_AUTO_SETUP").is_none() {
            assert!(
                envs.iter()
                    .any(|(k, v)| k == "HERMES_NPM_AUTO_SETUP" && v.as_deref() == Some("0")),
                "expected HERMES_NPM_AUTO_SETUP=0 in npm install command env, got: {envs:?}"
            );
        }
        assert!(
            envs.iter().any(|(k, _)| k == "npm_config_prefix"),
            "expected npm_config_prefix in npm install command env"
        );
    }

    #[test]
    fn cleanup_stale_npm_staging_dirs_removes_matching_unscoped_and_scoped_temps_only() {
        let temp = tempfile::tempdir().unwrap();
        let modules = temp.path().join("node_modules");
        std::fs::create_dir_all(modules.join(".openclaw-AbCd1234")).unwrap();
        std::fs::create_dir_all(modules.join("openclaw")).unwrap();
        std::fs::create_dir_all(modules.join(".otherpkg-1234")).unwrap();

        let removed = cleanup_stale_npm_staging_dirs(temp.path(), "openclaw");
        assert_eq!(removed, 1);
        assert!(!modules.join(".openclaw-AbCd1234").exists());
        assert!(modules.join("openclaw").exists());
        assert!(modules.join(".otherpkg-1234").exists());

        let scope = modules.join("@xai-official");
        std::fs::create_dir_all(scope.join(".grok-9999")).unwrap();
        std::fs::create_dir_all(scope.join("grok")).unwrap();
        let scoped_removed = cleanup_stale_npm_staging_dirs(temp.path(), "@xai-official/grok");
        assert_eq!(scoped_removed, 1);
        assert!(!scope.join(".grok-9999").exists());
        assert!(scope.join("grok").exists());
    }

    #[test]
    fn format_npm_lock_error_mentions_locks_and_antivirus() {
        let err = format_npm_lock_error(
            &anyhow::anyhow!("EPERM: operation not permitted, rename"),
            Path::new(r"C:\Users\dev\AppData\Roaming\npm"),
        );
        let text = err.to_string();
        assert!(text.contains("EPERM/EBUSY"));
        assert!(text.contains("杀毒软件") || text.contains("Windows Defender"));
    }
}
