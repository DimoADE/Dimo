use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::{
    error::PluginError,
    package::{PluginPackage, checked_package_path},
};

impl PluginPackage {
    pub fn freeze_execution_root(
        &mut self,
        storage_root: &Path,
        expected_digest: &str,
    ) -> Result<(), PluginError> {
        if expected_digest.len() != 64
            || !expected_digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginError::invalid_manifest(
                "candidate digest must be lowercase SHA-256 hex",
            ));
        }
        validate_storage_segment(self.id.as_str())?;
        let publisher = self.publisher.as_deref().unwrap_or("local");
        validate_storage_segment(publisher)?;
        fs::create_dir_all(storage_root)
            .map_err(|error| PluginError::io("create candidate storage", error))?;
        let storage_root = storage_root
            .canonicalize()
            .map_err(|error| PluginError::io("resolve candidate storage", error))?;
        let parent = storage_root.join(publisher).join(self.id.as_str());
        fs::create_dir_all(&parent)
            .map_err(|error| PluginError::io("create candidate identity storage", error))?;
        let target = parent.join(expected_digest);
        if !target.exists() {
            let staging = parent.join(format!(".{expected_digest}.incoming"));
            if staging.exists() {
                remove_snapshot_path(&staging)?;
            }
            copy_digest_files(&self.source.path, &staging)?;
            if self.source.path.join("config.json").is_file() {
                let config_source = checked_package_path(&self.source.path, "config.json")?;
                fs::copy(config_source, staging.join("config.json"))
                    .map_err(|error| PluginError::io("copy Plugin config into candidate", error))?;
            }
            Self::inspect(&staging, self.source.kind)?;
            let staged_digest = package_content_digest(&staging)?;
            if staged_digest != expected_digest {
                remove_snapshot_path(&staging)?;
                return Err(PluginError::invalid_manifest(
                    "linked source changed while the candidate was being frozen",
                ));
            }
            fs::rename(&staging, &target)
                .map_err(|error| PluginError::io("publish frozen candidate", error))?;
        }
        if package_content_digest(&target)? != expected_digest {
            return Err(PluginError::invalid_manifest(
                "frozen candidate digest does not match its content address",
            ));
        }
        self.execution_root = Some(
            target
                .canonicalize()
                .map_err(|error| PluginError::io("resolve frozen candidate", error))?,
        );
        Ok(())
    }
}

pub fn package_content_digest(root: &Path) -> Result<String, PluginError> {
    let root = root
        .canonicalize()
        .map_err(|error| PluginError::io("canonicalize Plugin package", error))?;
    let mut files = Vec::new();
    collect_digest_files(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut rows = Vec::with_capacity(files.len());
    for (relative, absolute) in files {
        let contents = fs::read(&absolute)
            .map_err(|error| PluginError::io("read Plugin package file", error))?;
        rows.push(format!(
            "{}\0{}\0{:x}",
            relative,
            contents.len(),
            Sha256::digest(&contents)
        ));
    }
    Ok(format!("{:x}", Sha256::digest(rows.join("\n").as_bytes())))
}

pub(crate) async fn package_content_digest_async(root: PathBuf) -> Result<String, PluginError> {
    tokio::task::spawn_blocking(move || package_content_digest(&root))
        .await
        .map_err(|error| {
            PluginError::io("join package digest task", std::io::Error::other(error))
        })?
}

fn collect_digest_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), PluginError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| PluginError::io("read Plugin package directory", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PluginError::io("read Plugin package entry", error))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| PluginError::io("inspect Plugin package entry", error))?;
        if file_type.is_symlink() {
            return Err(PluginError::invalid_manifest(format!(
                "package symlink is not allowed: {}",
                entry.path().display()
            )));
        }
        let name = entry.file_name();
        if file_type.is_dir() && matches!(name.to_str(), Some(".git" | "node_modules")) {
            continue;
        }
        if file_type.is_dir() {
            collect_digest_files(root, &entry.path(), files)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(PluginError::invalid_manifest(format!(
                "unsupported package entry: {}",
                entry.path().display()
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if relative.ends_with(".vxp")
            || matches!(
                relative.as_str(),
                "config.json"
                    | ".dimo-plugin/package.lock.json"
                    | ".dimo-plugin/developer-link.json"
            )
        {
            continue;
        }
        files.push((relative, entry.path()));
    }
    Ok(())
}

fn copy_digest_files(source: &Path, target: &Path) -> Result<(), PluginError> {
    let mut files = Vec::new();
    collect_digest_files(source, source, &mut files)?;
    fs::create_dir_all(target)
        .map_err(|error| PluginError::io("create frozen candidate", error))?;
    for (relative, absolute) in files {
        let destination = target.join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| PluginError::io("create candidate directory", error))?;
        }
        fs::copy(&absolute, &destination)
            .map_err(|error| PluginError::io("copy candidate file", error))?;
    }
    Ok(())
}

pub(crate) fn validate_storage_segment(id: &str) -> Result<(), PluginError> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(PluginError::invalid_manifest(format!(
            "plugin id `{id}` cannot be used as a snapshot directory"
        )));
    }
    Ok(())
}

pub(crate) fn copy_snapshot_directory(source: &Path, target: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(target)
        .map_err(|error| PluginError::io("create plugin snapshot target", error))?;
    let entries = fs::read_dir(source)
        .map_err(|error| PluginError::io("read plugin snapshot source", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| PluginError::io("read plugin snapshot entry", error))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| PluginError::io("inspect plugin snapshot entry", error))?;
        if file_type.is_dir() {
            copy_snapshot_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| PluginError::io("copy plugin snapshot file", error))?;
        } else {
            return Err(PluginError::invalid_manifest(format!(
                "snapshot import refuses non-file entry `{}`",
                source_path.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn remove_snapshot_path(path: &Path) -> Result<(), PluginError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PluginError::io("inspect plugin snapshot target", error))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|error| PluginError::io("remove plugin snapshot file", error))
    } else {
        fs::remove_dir_all(path)
            .map_err(|error| PluginError::io("remove plugin snapshot directory", error))
    }
}

pub(crate) fn prune_stale_snapshot_dirs(storage_root: &Path, plugin_id: &str) {
    let incoming_exact = format!(".{plugin_id}.incoming");
    let incoming_prefix = format!(".{plugin_id}.incoming.");
    let superseded_prefix = format!(".{plugin_id}.superseded.");
    let Ok(entries) = fs::read_dir(storage_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == incoming_exact
            || name.starts_with(&incoming_prefix)
            || name.starts_with(&superseded_prefix)
        {
            let _ = remove_snapshot_path(&entry.path());
        }
    }
}

pub(crate) fn find_existing_snapshot_config(
    storage_root: &Path,
    target: &Path,
    plugin_id: &str,
) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let direct = target.join("config.json");
    if direct.is_file() {
        let mtime = fs::metadata(&direct)
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        best = Some((mtime, direct));
    }
    let sibling_prefix = format!("{plugin_id}-");
    if let Ok(entries) = fs::read_dir(storage_root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with(&sibling_prefix) {
                continue;
            }
            let candidate = entry.path().join("config.json");
            if !candidate.is_file() {
                continue;
            }
            let mtime = fs::metadata(&candidate)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(prev, _)| mtime > *prev) {
                best = Some((mtime, candidate));
            }
        }
    }
    best.map(|(_, path)| path)
}

pub(crate) fn activate_staged_snapshot(
    storage_root: &Path,
    plugin_id: &str,
    staging: &Path,
    target: &Path,
    suffix: &str,
) -> Result<PathBuf, PluginError> {
    if !target.exists() {
        return match fs::rename(staging, target) {
            Ok(()) => Ok(target.to_path_buf()),
            Err(error) => {
                let _ = remove_snapshot_path(staging);
                Err(PluginError::io("activate plugin snapshot", error))
            }
        };
    }

    // Move the prior snapshot aside atomically instead of deleting it in place.
    // On Windows, an open directory handle or running helper binary inside
    // `target` makes `remove_dir_all` partially delete files and fail with
    // sharing/access errors. When `target` is locked, activate into a sibling
    // snapshot directory so installation still succeeds cleanly.
    let superseded = storage_root.join(format!(".{plugin_id}.superseded.{suffix}"));
    match fs::rename(target, &superseded) {
        Ok(()) => match fs::rename(staging, target) {
            Ok(()) => {
                let _ = remove_snapshot_path(&superseded);
                Ok(target.to_path_buf())
            }
            Err(error) => {
                let _ = fs::rename(&superseded, target);
                let _ = remove_snapshot_path(staging);
                Err(PluginError::io("activate plugin snapshot", error))
            }
        },
        Err(lock_error) => {
            tracing::warn!(
                plugin_id,
                target = %target.display(),
                error = %lock_error,
                "existing plugin snapshot directory is locked; activating into a sibling snapshot directory"
            );
            let sibling = storage_root.join(format!("{plugin_id}-{suffix}"));
            match fs::rename(staging, &sibling) {
                Ok(()) => Ok(sibling),
                Err(error) => {
                    let _ = remove_snapshot_path(staging);
                    Err(PluginError::io("activate plugin snapshot", error))
                }
            }
        }
    }
}
