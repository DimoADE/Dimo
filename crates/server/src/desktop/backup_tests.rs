use super::*;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

async fn open_wal_pool(db_path: &Path) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(db_path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .expect("open wal sqlite pool")
}

fn test_roots(base: &Path) -> BackupRoots {
    let asset_dir = base.join("asset");
    let dimo_root = base.join(".dimo");
    fs::create_dir_all(&asset_dir).unwrap();
    fs::create_dir_all(&dimo_root).unwrap();
    BackupRoots {
        asset_dir,
        dimo_root,
    }
}

#[tokio::test]
async fn backup_create_checkpoints_wal_and_captures_uncheckpointed_writes() {
    let temp = tempfile::tempdir().unwrap();
    let roots = test_roots(temp.path());
    let db_path = roots.asset_dir.join("db.sqlite");
    let pool = open_wal_pool(&db_path).await;

    // Disable automatic WAL checkpointing so committed writes stay in -wal until
    // backup_create explicitly checkpoints / snapshots SQLite.
    sqlx::query("PRAGMA wal_autocheckpoint = 0")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO notes (id, body) VALUES (1, 'wal-only-payload')")
        .execute(&pool)
        .await
        .unwrap();

    let wal_path = roots.asset_dir.join("db.sqlite-wal");
    assert!(
        wal_path.metadata().map(|m| m.len()).unwrap_or(0) > 0,
        "expected pending WAL frames before backup_create"
    );

    let backup_file = temp.path().join("wal-backup.json");
    let events = Arc::new(crate::HostEventBus::new());
    let preview = backup_create_with_roots(
        events,
        Some(&pool),
        roots.clone(),
        BackupCreateOptions {
            path: backup_file.to_string_lossy().to_string(),
        },
    )
    .await
    .expect("backup_create should succeed");

    assert_eq!(
        preview.manifest.app_version,
        utils::version::runtime_app_version()
    );
    // Verify WAL was truncated by PRAGMA wal_checkpoint(TRUNCATE).
    assert_eq!(wal_path.metadata().map(|m| m.len()).unwrap_or(0), 0);

    // Extract backed-up db.sqlite bytes into a fresh file and verify the row exists.
    let parsed = read_backup_file(&backup_file).unwrap();
    let db_entry = parsed
        .entries
        .iter()
        .find(|e| e.path == "asset/db.sqlite")
        .expect("backup contains asset/db.sqlite");
    let db_bytes = general_purpose::STANDARD
        .decode(&db_entry.bytes_base64)
        .unwrap();
    let restored_copy = temp.path().join("extracted.sqlite");
    fs::write(&restored_copy, db_bytes).unwrap();

    let check_pool = open_wal_pool(&restored_copy).await;
    let body: String = sqlx::query_scalar("SELECT body FROM notes WHERE id = 1")
        .fetch_one(&check_pool)
        .await
        .unwrap();
    assert_eq!(body, "wal-only-payload");

    check_pool.close().await;
    pool.close().await;
}

#[tokio::test]
async fn backup_restore_stages_when_pool_is_open_and_applies_atomically_after_close() {
    let temp = tempfile::tempdir().unwrap();
    let roots = test_roots(temp.path());
    let events = Arc::new(crate::HostEventBus::new());

    // 1. Seed backup state and create backup.
    let db_path = roots.asset_dir.join("db.sqlite");
    {
        let pool = open_wal_pool(&db_path).await;
        sqlx::query("CREATE TABLE items (name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO items (name) VALUES ('from-backup')")
            .execute(&pool)
            .await
            .unwrap();
        fs::write(roots.asset_dir.join("settings.json"), r#"{"theme":"backup"}"#).unwrap();

        let backup_file = temp.path().join("snapshot.json");
        backup_create_with_roots(
            Arc::clone(&events),
            Some(&pool),
            roots.clone(),
            BackupCreateOptions {
                path: backup_file.to_string_lossy().to_string(),
            },
        )
        .await
        .unwrap();

        // 2. Mutate live DB and settings while keeping the pool actively open
        // (holds open file handles on Windows).
        sqlx::query("DELETE FROM items").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO items (name) VALUES ('live-mutated')")
            .execute(&pool)
            .await
            .unwrap();
        fs::write(roots.asset_dir.join("settings.json"), r#"{"theme":"live"}"#).unwrap();

        // 3. Stage restore while pool is open — must NOT fail with sharing violation
        // and must NOT overwrite settings.json before db.sqlite can be replaced.
        let result = backup_restore_stage_with_roots(
            Arc::clone(&events),
            true,
            roots.clone(),
            BackupRestoreStagePayload {
                path: backup_file.to_string_lossy().to_string(),
                confirmed: true,
            },
        )
        .await
        .expect("staged restore must succeed while SqlitePool is open");
        assert!(result.requires_reload);
        assert!(
            roots
                .asset_dir
                .join(PENDING_RESTORE_DIR)
                .join(PENDING_RESTORE_MANIFEST)
                .is_file()
        );
        assert_eq!(
            fs::read_to_string(roots.asset_dir.join("settings.json")).unwrap(),
            r#"{"theme":"live"}"#
        );

        pool.close().await;
    }

    // 4. Apply pending restore once the pool is closed.
    let applied = apply_pending_backup_restore(&roots.asset_dir)
        .expect("apply_pending_backup_restore should succeed");
    assert_eq!(applied, 2);
    assert!(!roots.asset_dir.join(PENDING_RESTORE_DIR).exists());
    assert_eq!(
        fs::read_to_string(roots.asset_dir.join("settings.json")).unwrap(),
        r#"{"theme":"backup"}"#
    );

    let verify_pool = open_wal_pool(&db_path).await;
    let name: String = sqlx::query_scalar("SELECT name FROM items")
        .fetch_one(&verify_pool)
        .await
        .unwrap();
    assert_eq!(name, "from-backup");
    verify_pool.close().await;
}

#[tokio::test]
async fn backup_restore_rolls_back_all_targets_when_commit_fails() {
    let temp = tempfile::tempdir().unwrap();
    let roots = test_roots(temp.path());
    let events = Arc::new(crate::HostEventBus::new());

    // Existing settings.json to verify rollback restores original bytes.
    let settings_path = roots.asset_dir.join("settings.json");
    fs::write(&settings_path, r#"{"original":true}"#).unwrap();

    // Create a non-empty directory at config.json so committing a file over it fails on all OSes.
    let blocker_dir = roots.asset_dir.join("config.json");
    fs::create_dir_all(&blocker_dir).unwrap();
    fs::write(blocker_dir.join("keep"), b"x").unwrap();

    let backup = PortableBackup {
        manifest: BackupManifest {
            format: BACKUP_FORMAT.to_string(),
            version: BACKUP_VERSION,
            created_at: Utc::now().to_rfc3339(),
            app_version: "1.0.0".to_string(),
            entry_count: 2,
            total_bytes: 20,
        },
        entries: vec![
            BackupEntry {
                path: "asset/settings.json".to_string(),
                size_bytes: 12,
                modified_at: None,
                bytes_base64: general_purpose::STANDARD.encode(br#"{"new":true}"#),
            },
            BackupEntry {
                path: "asset/config.json".to_string(),
                size_bytes: 8,
                modified_at: None,
                bytes_base64: general_purpose::STANDARD.encode(br#"{"c":1}"#),
            },
        ],
    };
    let backup_file = temp.path().join("rollback-test.json");
    fs::write(&backup_file, serde_json::to_vec(&backup).unwrap()).unwrap();

    let err = backup_restore_stage_with_roots(
        events,
        false,
        roots.clone(),
        BackupRestoreStagePayload {
            path: backup_file.to_string_lossy().to_string(),
            confirmed: true,
        },
    )
    .await
    .expect_err("restore should fail when target is a non-empty directory");
    assert!(err.to_string().contains("Failed to"));

    // Verify settings.json was rolled back to its original content.
    assert_eq!(
        fs::read_to_string(&settings_path).unwrap(),
        r#"{"original":true}"#
    );
    // Verify no stray .dimo-restore.* or .dimo-rollback.* temps remain.
    let leftover: Vec<_> = fs::read_dir(&roots.asset_dir)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(is_internal_backup_temp_name)
        })
        .collect();
    assert!(leftover.is_empty(), "leftover temp files: {leftover:?}");
}
