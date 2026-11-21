//! Host-family in-place upgrade: verify checksums, snapshot the data directory,
//! then replace sibling binaries.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostUpgradePlan {
    pub release_dir: PathBuf,
    pub install_dir: PathBuf,
    pub data_dir: PathBuf,
    pub snapshot_dir: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum HostUpgradeError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub fn plan_host_upgrade(
    release_dir: impl AsRef<Path>,
    install_dir: impl AsRef<Path>,
    data_dir: impl AsRef<Path>,
) -> Result<HostUpgradePlan, HostUpgradeError> {
    let release_dir = release_dir.as_ref().to_path_buf();
    let install_dir = install_dir.as_ref().to_path_buf();
    let data_dir = data_dir.as_ref().to_path_buf();
    if !release_dir.join("SHA256SUMS").is_file() {
        return Err(HostUpgradeError::Invalid(
            "release directory must contain SHA256SUMS".into(),
        ));
    }
    if !install_dir.is_dir() {
        return Err(HostUpgradeError::Invalid(
            "install directory does not exist".into(),
        ));
    }
    Ok(HostUpgradePlan {
        snapshot_dir: data_dir.join("upgrade-snapshots"),
        release_dir,
        install_dir,
        data_dir,
    })
}

pub fn apply_host_upgrade(plan: &HostUpgradePlan) -> Result<PathBuf, HostUpgradeError> {
    if cfg!(windows) && is_running_exe_dir(&plan.install_dir) {
        return Err(HostUpgradeError::Invalid(
            "in-place host upgrade cannot overwrite the running Windows executable; stop dimo-server or use the desktop installer".into(),
        ));
    }
    verify_checksums(&plan.release_dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let snapshot = plan.snapshot_dir.join(stamp);
    if plan.data_dir.exists() {
        copy_dir(&plan.data_dir, &snapshot)?;
    } else {
        fs::create_dir_all(&snapshot)?;
    }
    for name in [
        "dimo-server",
        "dimo-mcp",
        "dimo-computer-helper",
        "dimo-server.exe",
        "dimo-mcp.exe",
        "dimo-computer-helper.exe",
    ] {
        let source = plan.release_dir.join(name);
        if source.is_file() {
            replace_binary(&source, &plan.install_dir.join(name))?;
        }
    }
    if plan.release_dir.join("web").is_dir() {
        let web = plan.install_dir.join("web");
        if web.exists() {
            fs::remove_dir_all(&web)?;
        }
        copy_dir(&plan.release_dir.join("web"), &web)?;
    }
    Ok(snapshot)
}

fn is_running_exe_dir(install_dir: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(exe_dir) = exe.parent() else {
        return false;
    };
    let norm_install = fs::canonicalize(install_dir).unwrap_or_else(|_| install_dir.to_path_buf());
    let norm_exe = fs::canonicalize(exe_dir).unwrap_or_else(|_| exe_dir.to_path_buf());
    if cfg!(windows) {
        norm_install
            .to_string_lossy()
            .eq_ignore_ascii_case(&norm_exe.to_string_lossy())
    } else {
        norm_install == norm_exe
    }
}

fn replace_binary(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let file_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("binary");
        let staged = destination.with_file_name(format!(".{file_name}.upgrade.tmp"));
        fs::copy(source, &staged)?;
        fs::rename(&staged, destination)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::copy(source, destination)?;
        Ok(())
    }
}

fn verify_checksums(release_dir: &Path) -> Result<(), HostUpgradeError> {
    let manifest = fs::read_to_string(release_dir.join("SHA256SUMS"))?;
    for line in manifest.lines().filter(|line| !line.trim().is_empty()) {
        let Some((digest, relative)) = line.split_once("  ") else {
            return Err(HostUpgradeError::Invalid(format!(
                "invalid checksum line: {line}"
            )));
        };
        let path = release_dir.join(relative);
        if !path.is_file() {
            continue;
        }
        let actual = hex_sha256(&fs::read(path)?);
        if actual != digest {
            return Err(HostUpgradeError::Invalid(format!(
                "checksum mismatch for {relative}"
            )));
        }
    }
    Ok(())
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn copy_dir(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if entry.file_name() == "upgrade-snapshots" {
                continue;
            }
            copy_dir(&from, &to)?;
        } else {
            fs::copy(from, to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_rejects_a_bad_checksum_before_touching_data() {
        let root = tempfile::tempdir().unwrap();
        let release = root.path().join("release");
        let install = root.path().join("install");
        let data = root.path().join("data");
        fs::create_dir_all(&release).unwrap();
        fs::create_dir_all(&install).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(release.join("dimo-server"), "new").unwrap();
        fs::write(data.join("db.sqlite"), "keep").unwrap();
        fs::write(release.join("SHA256SUMS"), "deadbeef  dimo-server\n").unwrap();

        let plan = plan_host_upgrade(&release, &install, &data).unwrap();
        let error = apply_host_upgrade(&plan).unwrap_err();
        assert!(matches!(error, HostUpgradeError::Invalid(_)));
        assert_eq!(fs::read_to_string(data.join("db.sqlite")).unwrap(), "keep");
        assert!(!install.join("dimo-server").exists());
    }

    #[test]
    fn upgrade_snapshots_data_and_replaces_binaries() {
        let root = tempfile::tempdir().unwrap();
        let release = root.path().join("release");
        let install = root.path().join("install");
        let data = root.path().join("data");
        fs::create_dir_all(&release).unwrap();
        fs::create_dir_all(&install).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(release.join("dimo-server"), "server-v2").unwrap();
        fs::write(release.join("dimo-mcp"), "mcp-v2").unwrap();
        let digest_server = hex_sha256(b"server-v2");
        let digest_mcp = hex_sha256(b"mcp-v2");
        fs::write(
            release.join("SHA256SUMS"),
            format!("{digest_server}  dimo-server\n{digest_mcp}  dimo-mcp\n"),
        )
        .unwrap();
        fs::write(install.join("dimo-server"), "server-v1").unwrap();
        fs::write(data.join("db.sqlite"), "state").unwrap();

        let plan = plan_host_upgrade(&release, &install, &data).unwrap();
        let snapshot = apply_host_upgrade(&plan).unwrap();
        assert_eq!(
            fs::read_to_string(install.join("dimo-server")).unwrap(),
            "server-v2"
        );
        assert_eq!(
            fs::read_to_string(snapshot.join("db.sqlite")).unwrap(),
            "state"
        );
    }
}
