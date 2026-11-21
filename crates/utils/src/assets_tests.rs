use std::path::{Path, PathBuf};

use super::{
    adopt_legacy_file, copy_missing_files, existing_official_plugin_roots,
    load_or_create_host_id, tauri_app_data_file_candidates,
};

#[test]
fn host_does_not_embed_plugin_packages() {
    let src = include_str!("assets.rs");
    assert!(!src.contains("#[folder = \"../../assets/plugins\"]"));
}

#[test]
fn packaged_host_data_dir_is_not_the_debug_tree() {
    let dir = super::default_host_data_dir();
    let text = dir.to_string_lossy();
    assert!(
        !text.contains("dev_assets"),
        "release Host data must use ProjectDirs, got {text}"
    );
    if cfg!(debug_assertions) {
        let debug_dir = super::asset_dir();
        assert!(
            debug_dir.to_string_lossy().contains("dev_assets"),
            "debug Desktop still uses the repo dev_assets tree"
        );
    } else {
        assert_eq!(super::asset_dir(), dir);
    }
}

#[test]
fn keeps_already_materialized_packages_when_scanning_the_host_data_directory() {
    let data = tempfile::tempdir().unwrap();
    let extra = data
        .path()
        .join("builtin-plugins/dev.example.extra/aaaaaaaaaaaa");
    std::fs::create_dir_all(extra.join(".dimo-plugin")).unwrap();
    std::fs::write(
        extra.join(".dimo-plugin/plugin.json"),
        br#"{"id":"dev.example.extra"}"#,
    )
    .unwrap();

    let roots = existing_official_plugin_roots(data.path());
    assert_eq!(roots, vec![extra]);
}

#[test]
fn host_identity_is_stable_for_a_data_directory() {
    let data = tempfile::tempdir().unwrap();
    let first = load_or_create_host_id(data.path()).unwrap();
    let second = load_or_create_host_id(data.path()).unwrap();
    assert!(!first.is_empty());
    assert_eq!(first, second);
    assert!(
        data.path().join("host-identity.json").is_file(),
        "host identity must live in the Host data directory"
    );
}

#[test]
fn adopt_legacy_file_copies_once_and_does_not_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("legacy.json");
    let dest = root.path().join("host/current.json");
    std::fs::write(&legacy, br#"{"from":"legacy"}"#).unwrap();
    adopt_legacy_file(Some(legacy.clone()), &dest);
    assert_eq!(
        std::fs::read_to_string(&dest).unwrap(),
        r#"{"from":"legacy"}"#
    );
    std::fs::write(&legacy, br#"{"from":"newer-legacy"}"#).unwrap();
    adopt_legacy_file(Some(legacy), &dest);
    assert_eq!(
        std::fs::read_to_string(&dest).unwrap(),
        r#"{"from":"legacy"}"#
    );
}

#[test]
fn copy_missing_files_fills_gaps_without_overwriting() {
    let root = tempfile::tempdir().unwrap();
    let from = root.path().join("legacy");
    let dest = root.path().join("host");
    std::fs::create_dir_all(&from).unwrap();
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(from.join("cached.json"), b"legacy").unwrap();
    std::fs::write(from.join("keep.json"), b"legacy-keep").unwrap();
    std::fs::write(dest.join("keep.json"), b"host-keep").unwrap();
    copy_missing_files(&from, &dest);
    assert_eq!(
        std::fs::read_to_string(dest.join("cached.json")).unwrap(),
        "legacy"
    );
    assert_eq!(
        std::fs::read_to_string(dest.join("keep.json")).unwrap(),
        "host-keep"
    );
}

#[test]
fn tauri_app_data_candidates_include_the_bundle_identifier() {
    let files = tauri_app_data_file_candidates("agent-model-providers.json");
    assert!(
        files.iter().any(|path| {
            path.components()
                .any(|component| component.as_os_str() == "com.dimo.app")
                && path
                    .file_name()
                    .is_some_and(|name| name == "agent-model-providers.json")
        }),
        "expected com.dimo.app candidate, got {files:?}"
    );
}

#[test]
fn install_data_dir_uses_install_dir_data_and_skips_cargo_target_dirs() {
    let root = tempfile::tempdir().unwrap();
    let install_dir = root.path().join("Dimo");
    std::fs::create_dir_all(&install_dir).unwrap();

    let resolved = super::install_data_dir_for_exe_dir(&install_dir)
        .expect("install_dir/data should be writable");
    assert_eq!(resolved, install_dir.join("data"));

    let debug_dir = root.path().join("target").join("debug");
    std::fs::create_dir_all(debug_dir.join("deps")).unwrap();
    assert!(super::install_data_dir_for_exe_dir(&debug_dir).is_none());
    assert!(super::install_data_dir_for_exe_dir(&debug_dir.join("deps")).is_none());
}

#[test]
fn legacy_data_dir_is_adopted_only_when_it_holds_a_database() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("roaming").join("data");
    let target = root.path().join("install").join("data");
    std::fs::create_dir_all(&legacy).unwrap();

    assert_eq!(
        super::legacy_data_dir_adoption(legacy.clone(), target.clone()),
        None
    );

    std::fs::write(legacy.join("db.sqlite"), b"sqlite").unwrap();
    assert_eq!(
        super::legacy_data_dir_adoption(legacy.clone(), target.clone()),
        Some(super::LegacyDataDirAdoption {
            legacy_dir: legacy.clone(),
            target_dir: target,
        })
    );
    assert_eq!(
        super::legacy_data_dir_adoption(legacy.clone(), legacy),
        None,
        "a directory is not adopted into itself"
    );
}

#[test]
fn empty_custom_data_dir_value_is_ignored() {
    let root = tempfile::tempdir().unwrap();
    let bootstrap = root.path().join("config").join("bootstrap.json");
    std::fs::create_dir_all(bootstrap.parent().unwrap()).unwrap();
    std::fs::write(&bootstrap, br#"{"custom_data_dir": ""}"#).unwrap();
    assert_eq!(super::read_custom_data_dir_from(&bootstrap), None);

    let custom = root.path().join("custom");
    super::save_bootstrap_config_to(
        &bootstrap,
        &super::BootstrapConfig {
            custom_data_dir: Some(custom.to_string_lossy().into_owned()),
        },
    )
    .unwrap();
    assert_eq!(super::read_custom_data_dir_from(&bootstrap), Some(custom));
}

#[test]
fn pre_rename_install_candidates_include_registry_sibling_and_standard_vibex_dirs() {
    let root = tempfile::tempdir().unwrap();
    let exe = root.path().join("Apps").join("Dimo").join("dimo.exe");
    let reg_dir = root.path().join("CustomVibeX");
    let local = root.path().join("LocalAppData");
    let pf = root.path().join("ProgramFiles");
    let pf86 = root.path().join("ProgramFilesX86");
    let home = root.path().join("Home");
    let app_data = root.path().join("Roaming");

    let candidates = super::pre_rename_install_data_dir_candidates_for(
        Some(&exe),
        Some(&local),
        Some(&pf),
        Some(&pf86),
        Some(&home),
        Some(&app_data),
        std::slice::from_ref(&reg_dir),
    );

    assert!(candidates.contains(&reg_dir.join("data")));
    if !cfg!(target_os = "macos") {
        assert!(candidates.contains(&root.path().join("Apps").join("VibeX").join("data")));
    }
    if cfg!(target_os = "windows") {
        assert!(candidates.contains(&local.join("VibeX").join("data")));
        assert!(candidates.contains(&local.join("Programs").join("VibeX").join("data")));
        assert!(candidates.contains(&pf.join("VibeX").join("data")));
    }
    assert!(candidates.contains(&app_data.join("com.vibex.app")));
}

#[test]
fn recorded_adopted_legacy_source_prevents_repeated_adoption() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("vibex").join("data");
    let target = root.path().join("dimo").join("data");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(legacy.join("db.sqlite"), b"sqlite").unwrap();

    assert!(super::legacy_data_dir_adoption(legacy.clone(), target.clone()).is_some());
    super::record_adopted_legacy_source(&target, &legacy).unwrap();
    assert_eq!(super::legacy_data_dir_adoption(legacy, target), None);
}

#[test]
fn release_data_dir_ignores_the_install_directory() {
    let install = PathBuf::from("/Applications/Dimo.app/Contents/MacOS/data");
    let stable = PathBuf::from("/Users/me/Library/Application Support/app.dimo.dimo");
    let resolved = super::resolve_release_data_dir(Some(&install), stable.clone());
    assert_eq!(resolved, stable);
    assert_ne!(resolved, install);
    assert_eq!(
        super::resolve_release_data_dir(None, stable.clone()),
        stable
    );
    assert_eq!(
        super::release_default_data_dir(),
        super::legacy_roaming_data_dir()
    );
}

#[test]
fn release_default_data_dir_does_not_create_an_install_directory() {
    let source = include_str!("assets.rs");
    let start = source
        .find("pub fn release_default_data_dir()")
        .expect("release_default_data_dir");
    let body = &source[start..];
    let end = body.find("\n}\n").expect("function end");
    let body = &body[..end];
    assert!(
        !body.contains("install_data_dir"),
        "resolving the live data directory must not probe or create <install>/data"
    );
    assert!(body.contains("resolve_release_data_dir(None"));
}

#[test]
fn dimo_install_candidates_start_with_the_running_bundle_data_dir() {
    let root = tempfile::tempdir().unwrap();
    let exe = root
        .path()
        .join("Dimo.app")
        .join("Contents")
        .join("MacOS")
        .join("dimo");
    let local = root.path().join("LocalAppData");
    let pf = root.path().join("ProgramFiles");
    let pf86 = root.path().join("ProgramFilesX86");
    let home = root.path().join("Home");
    let candidates = super::dimo_install_data_dir_candidates_for(
        Some(&exe),
        Some(&local),
        Some(&pf),
        Some(&pf86),
        Some(&home),
    );
    let bundle_data = exe.parent().unwrap().join("data");
    assert_eq!(candidates.first(), Some(&bundle_data));
    assert!(!candidates.contains(&super::legacy_roaming_data_dir()));
    if cfg!(target_os = "windows") {
        assert!(candidates.contains(&local.join("Dimo").join("data")));
        assert!(candidates.contains(&local.join("Programs").join("Dimo").join("data")));
        assert!(candidates.contains(&pf.join("Dimo").join("data")));
    }
    if cfg!(target_os = "macos") {
        assert!(
            candidates.contains(
                &home
                    .join("Applications")
                    .join("Dimo.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("data")
            )
        );
        assert!(
            candidates.contains(&PathBuf::from("/Applications/Dimo.app/Contents/MacOS/data"))
        );
    }
    if cfg!(target_os = "linux") {
        assert!(candidates.contains(&PathBuf::from("/opt/Dimo/data")));
    }
}

#[test]
fn dimo_install_candidates_skip_cargo_build_trees() {
    let root = tempfile::tempdir().unwrap();
    let exe = root
        .path()
        .join("target")
        .join("debug")
        .join("deps")
        .join("dimo-test");
    let candidates =
        super::dimo_install_data_dir_candidates_for(Some(&exe), None, None, None, None);
    assert!(
        candidates.iter().all(|dir| !dir.starts_with(root.path())),
        "cargo test binaries must not adopt target/debug/deps/data: {candidates:?}"
    );
}

#[test]
fn superseded_siblings_with_a_database_are_adoption_sources() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let kept = root.path().join("data.superseded-20261118-120000");
    std::fs::create_dir_all(&kept).unwrap();
    std::fs::write(kept.join("db.sqlite"), b"sqlite").unwrap();
    let empty = root.path().join("data.superseded-20261118-130000");
    std::fs::create_dir_all(&empty).unwrap();
    std::fs::write(root.path().join("data.superseded-note.txt"), b"no").unwrap();

    let found = super::superseded_data_dirs_beside(&data);
    assert_eq!(found, vec![kept]);
}

#[test]
fn app_update_deletes_only_a_macos_bundle_database() {
    let exe = Path::new("/Applications/Dimo.app/Contents/MacOS/dimo");
    let data = Path::new("/Applications/Dimo.app/Contents/MacOS/data");
    let aside =
        Path::new("/Applications/Dimo.app/Contents/MacOS/data.superseded-20261118-120000");
    let roaming = Path::new("/Users/me/Library/Application Support/app.dimo.dimo");
    assert!(super::app_update_deletes_directory(true, exe, data));
    assert!(super::app_update_deletes_directory(true, exe, aside));
    assert!(!super::app_update_deletes_directory(false, exe, data));
    assert!(!super::app_update_deletes_directory(true, exe, roaming));

    let cargo = Path::new("/repo/target/debug/deps/dimo-test");
    let cargo_data = Path::new("/repo/target/debug/deps/data");
    assert!(!super::app_update_deletes_directory(
        true, cargo, cargo_data
    ));

    let windows = Path::new(r"C:\Users\me\AppData\Local\Dimo\dimo.exe");
    let windows_data = Path::new(r"C:\Users\me\AppData\Local\Dimo\data");
    assert!(!super::app_update_deletes_directory(
        false,
        windows,
        windows_data
    ));
}

#[test]
fn rejects_macos_app_bundle_paths_for_writable_data_dirs() {
    let root = tempfile::tempdir().unwrap();
    let bundle_exec_dir = root.path().join("Dimo.app").join("Contents").join("MacOS");
    std::fs::create_dir_all(&bundle_exec_dir).unwrap();
    assert!(super::is_inside_macos_app_bundle(&bundle_exec_dir));
    assert!(super::is_inside_macos_app_bundle(&bundle_exec_dir.join("data")));
    assert!(super::is_inside_macos_app_bundle_for_os(
        true,
        Path::new("/Applications/Dimo.app/data")
    ));
    assert!(!super::is_inside_macos_app_bundle(
        Path::new("/Users/me/Library/Application Support/app.dimo.dimo")
    ));
    assert_eq!(super::install_data_dir_for_exe_dir(&bundle_exec_dir), None);

    let bootstrap = root.path().join("config").join("bootstrap.json");
    let bundle_data = bundle_exec_dir.join("data");
    super::save_bootstrap_config_to(
        &bootstrap,
        &super::BootstrapConfig {
            custom_data_dir: Some(bundle_data.to_string_lossy().into_owned()),
        },
    )
    .unwrap();
    assert_eq!(super::read_custom_data_dir_from(&bootstrap), None);
    assert!(super::set_custom_data_dir(Some(&bundle_data)).is_err());
}

#[test]
fn electron_windows_resources_bin_layout_resolves_install_root_and_vibex_sibling() {
    let root = tempfile::tempdir().unwrap();
    let install_root = root.path().join("Programs").join("Dimo");
    let exe = install_root
        .join("resources")
        .join("bin")
        .join("dimo-server.exe");

    assert_eq!(
        super::packaged_install_dir_for(&exe),
        Some(install_root.clone())
    );
    let scan_dirs = super::packaged_install_scan_dirs_for(&exe);
    assert_eq!(scan_dirs.first(), Some(&install_root));
    assert_eq!(scan_dirs.get(1), Some(&install_root.join("resources").join("bin")));

    let dimo_candidates =
        super::dimo_install_data_dir_candidates_for(Some(&exe), None, None, None, None);
    assert_eq!(dimo_candidates.first(), Some(&install_root.join("data")));

    let vibex_candidates = super::pre_rename_install_data_dir_candidates_for(
        Some(&exe),
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    if !cfg!(target_os = "macos") {
        assert!(
            vibex_candidates.contains(&root.path().join("Programs").join("VibeX").join("data")),
            "expected sibling VibeX/data, got {vibex_candidates:?}"
        );
    }
}

#[test]
fn electron_macos_resources_bin_layout_resolves_contents_macos_and_vibex_bundle() {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("Applications").join("Dimo.app");
    let exe = bundle
        .join("Contents")
        .join("Resources")
        .join("bin")
        .join("dimo-server");
    let expected_macos = bundle.join("Contents").join("MacOS");

    assert_eq!(
        super::packaged_install_dir_for(&exe),
        Some(expected_macos.clone())
    );
    let scan_dirs = super::packaged_install_scan_dirs_for(&exe);
    assert_eq!(scan_dirs.first(), Some(&expected_macos));
    assert_eq!(
        scan_dirs.get(1),
        Some(&bundle.join("Contents").join("Resources").join("bin"))
    );

    let dimo_candidates =
        super::dimo_install_data_dir_candidates_for(Some(&exe), None, None, None, None);
    assert_eq!(
        dimo_candidates.first(),
        Some(&expected_macos.join("data"))
    );

    let vibex_candidates = super::pre_rename_install_data_dir_candidates_for(
        Some(&exe),
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    let expected_vibex = root
        .path()
        .join("Applications")
        .join("VibeX.app")
        .join("Contents")
        .join("MacOS")
        .join("data");
    assert!(
        vibex_candidates.contains(&expected_vibex),
        "expected sibling VibeX.app/Contents/MacOS/data, got {vibex_candidates:?}"
    );
    assert!(super::app_update_deletes_directory(
        true,
        &exe,
        &expected_macos.join("data")
    ));
}

#[test]
fn electron_linux_resources_bin_layout_resolves_install_root_and_candidates() {
    let root = tempfile::tempdir().unwrap();
    let install_root = root.path().join("opt").join("Dimo");
    let exe = install_root
        .join("resources")
        .join("bin")
        .join("dimo-server");

    assert_eq!(
        super::packaged_install_dir_for(&exe),
        Some(install_root.clone())
    );
    let dimo_candidates =
        super::dimo_install_data_dir_candidates_for(Some(&exe), None, None, None, None);
    assert_eq!(dimo_candidates.first(), Some(&install_root.join("data")));

    let vibex_candidates = super::pre_rename_install_data_dir_candidates_for(
        Some(&exe),
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    if !cfg!(target_os = "macos") {
        assert!(
            vibex_candidates.contains(&root.path().join("opt").join("VibeX").join("data")),
            "expected sibling VibeX/data, got {vibex_candidates:?}"
        );
    }
    if cfg!(target_os = "linux") {
        assert!(vibex_candidates.contains(&root.path().join("opt").join("vibex").join("data")));
    }
}
