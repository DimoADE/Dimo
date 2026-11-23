use sqlx::{Executor, FromRow, Sqlite, SqlitePool};

/// Stamp for one vendor jsonl file. Unchanged mtime+size means skip parse.
#[derive(Debug, Clone, FromRow)]
pub struct VendorUsageFileRecord {
    pub path: String,
    pub provider: String,
    pub mtime_ms: i64,
    pub size: i64,
    pub scanned_at_ms: i64,
    pub generation: i64,
}

/// One vendor session's token breakdown, keyed by the vendor's session id.
#[derive(Debug, Clone, FromRow)]
pub struct VendorUsageSessionRecord {
    pub provider: String,
    pub external_session_id: String,
    pub source_path: String,
    pub timestamp: i64,
    pub model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost: Option<f64>,
    pub summary: Option<String>,
    pub scanned_at_ms: i64,
    pub turns: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct VendorUsageFileUpdate {
    pub path: String,
    pub provider: String,
    pub mtime_ms: i64,
    pub size: i64,
    pub generation: i64,
    pub session: Option<VendorUsageSessionRecord>,
}

impl VendorUsageFileRecord {
    pub async fn has_any<'e, E>(executor: E) -> Result<bool, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let row: Option<(i64,)> = sqlx::query_as(r#"SELECT 1 FROM vendor_usage_files LIMIT 1"#)
            .fetch_optional(executor)
            .await?;
        Ok(row.is_some())
    }

    pub async fn list<'e, E>(executor: E) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT path, provider, mtime_ms, size, scanned_at_ms, generation
               FROM vendor_usage_files"#,
        )
        .fetch_all(executor)
        .await
    }
}

impl VendorUsageSessionRecord {
    pub async fn list_all<'e, E>(executor: E) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        Self::list_since(executor, 0).await
    }

    pub async fn list_since<'e, E>(
        executor: E,
        cutoff_time_ms: i64,
    ) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        if cutoff_time_ms <= 0 {
            sqlx::query_as::<_, Self>(
                r#"SELECT provider,
                          external_session_id,
                          source_path,
                          timestamp,
                          model,
                          input_tokens,
                          output_tokens,
                          cache_write_tokens,
                          cache_read_tokens,
                          total_tokens,
                          cost,
                          summary,
                          scanned_at_ms,
                          turns
                   FROM vendor_usage_sessions"#,
            )
            .fetch_all(executor)
            .await
        } else {
            sqlx::query_as::<_, Self>(
                r#"SELECT provider,
                          external_session_id,
                          source_path,
                          timestamp,
                          model,
                          input_tokens,
                          output_tokens,
                          cache_write_tokens,
                          cache_read_tokens,
                          total_tokens,
                          cost,
                          summary,
                          scanned_at_ms,
                          turns
                   FROM vendor_usage_sessions
                   WHERE timestamp >= ?"#,
            )
            .bind(cutoff_time_ms)
            .fetch_all(executor)
            .await
        }
    }

    pub async fn count_by_provider<'e, E>(executor: E) -> Result<Vec<(String, i64)>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, (String, i64)>(
            r#"SELECT provider, COUNT(*) FROM vendor_usage_sessions GROUP BY provider"#,
        )
        .fetch_all(executor)
        .await
    }
}

/// Persist one incremental scan: upsert changed files, drop rows for files that
/// vanished from providers that listed successfully. Returns `true` when at
/// least one file row was inserted, updated, or removed.
pub async fn apply_vendor_usage_scan(
    pool: &SqlitePool,
    updates: &[VendorUsageFileUpdate],
    live_paths: &[String],
    successful_providers: &[String],
    now_ms: i64,
) -> Result<bool, sqlx::Error> {
    let live: std::collections::HashSet<&str> = live_paths.iter().map(String::as_str).collect();
    let vanished_paths = if !successful_providers.is_empty() {
        let existing = sqlx::query_as::<_, (String, String)>(
            r#"SELECT path, provider FROM vendor_usage_files"#,
        )
        .fetch_all(pool)
        .await?;
        existing
            .into_iter()
            .filter(|(path, provider)| {
                successful_providers.iter().any(|item| item == provider)
                    && !live.contains(path.as_str())
            })
            .map(|(path, _)| path)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    if updates.is_empty() && vanished_paths.is_empty() {
        return Ok(false);
    }

    let mut tx = pool.begin().await?;

    for update in updates {
        sqlx::query("DELETE FROM vendor_usage_sessions WHERE source_path = ?")
            .bind(&update.path)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"INSERT INTO vendor_usage_files (path, provider, mtime_ms, size, scanned_at_ms, generation)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET
                   provider = excluded.provider,
                   mtime_ms = excluded.mtime_ms,
                   size = excluded.size,
                   scanned_at_ms = excluded.scanned_at_ms,
                   generation = excluded.generation"#,
        )
        .bind(&update.path)
        .bind(&update.provider)
        .bind(update.mtime_ms)
        .bind(update.size)
        .bind(now_ms)
        .bind(update.generation)
        .execute(&mut *tx)
        .await?;

        if let Some(session) = &update.session {
            sqlx::query(
                r#"INSERT INTO vendor_usage_sessions (
                       provider,
                       external_session_id,
                       source_path,
                       timestamp,
                       model,
                       input_tokens,
                       output_tokens,
                       cache_write_tokens,
                       cache_read_tokens,
                       total_tokens,
                       cost,
                       summary,
                       scanned_at_ms,
                       turns
                   )
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(provider, external_session_id) DO UPDATE SET
                       source_path = excluded.source_path,
                       timestamp = excluded.timestamp,
                       model = excluded.model,
                       input_tokens = excluded.input_tokens,
                       output_tokens = excluded.output_tokens,
                       cache_write_tokens = excluded.cache_write_tokens,
                       cache_read_tokens = excluded.cache_read_tokens,
                       total_tokens = excluded.total_tokens,
                       cost = excluded.cost,
                       summary = excluded.summary,
                       scanned_at_ms = excluded.scanned_at_ms,
                       turns = excluded.turns"#,
            )
            .bind(&session.provider)
            .bind(&session.external_session_id)
            .bind(&update.path)
            .bind(session.timestamp)
            .bind(session.model.as_deref())
            .bind(session.input_tokens)
            .bind(session.output_tokens)
            .bind(session.cache_write_tokens)
            .bind(session.cache_read_tokens)
            .bind(session.total_tokens)
            .bind(session.cost)
            .bind(session.summary.as_deref())
            .bind(now_ms)
            .bind(session.turns)
            .execute(&mut *tx)
            .await?;
        }
    }

    for path in vanished_paths {
        sqlx::query("DELETE FROM vendor_usage_sessions WHERE source_path = ?")
            .bind(&path)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM vendor_usage_files WHERE path = ?")
            .bind(&path)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    #[tokio::test]
    async fn apply_vendor_usage_scan_skips_write_on_noop_and_lists_since_cutoff() {
        let pool = setup_pool().await;
        assert!(!VendorUsageFileRecord::has_any(&pool).await.unwrap());

        let old_session = VendorUsageSessionRecord {
            provider: "codex".to_string(),
            external_session_id: "sess-old".to_string(),
            source_path: "/tmp/old.jsonl".to_string(),
            timestamp: 1_000,
            model: Some("gpt-5".to_string()),
            input_tokens: Some(10),
            output_tokens: Some(5),
            cache_write_tokens: None,
            cache_read_tokens: None,
            total_tokens: Some(15),
            cost: None,
            summary: Some("old".to_string()),
            scanned_at_ms: 1_000,
            turns: Some(1),
        };
        let new_session = VendorUsageSessionRecord {
            provider: "codex".to_string(),
            external_session_id: "sess-new".to_string(),
            source_path: "/tmp/new.jsonl".to_string(),
            timestamp: 5_000,
            model: Some("gpt-5".to_string()),
            input_tokens: Some(20),
            output_tokens: Some(10),
            cache_write_tokens: None,
            cache_read_tokens: None,
            total_tokens: Some(30),
            cost: None,
            summary: Some("new".to_string()),
            scanned_at_ms: 5_000,
            turns: Some(2),
        };

        let updates = vec![
            VendorUsageFileUpdate {
                path: "/tmp/old.jsonl".to_string(),
                provider: "codex".to_string(),
                mtime_ms: 1_000,
                size: 100,
                generation: 1,
                session: Some(old_session),
            },
            VendorUsageFileUpdate {
                path: "/tmp/new.jsonl".to_string(),
                provider: "codex".to_string(),
                mtime_ms: 5_000,
                size: 200,
                generation: 1,
                session: Some(new_session),
            },
        ];

        let providers = vec!["codex".to_string()];

        assert!(
            apply_vendor_usage_scan(
                &pool,
                &updates,
                &["/tmp/old.jsonl".to_string(), "/tmp/new.jsonl".to_string()],
                &providers,
                10_000
            )
            .await
            .unwrap()
        );
        assert!(VendorUsageFileRecord::has_any(&pool).await.unwrap());

        // No updates and all paths still present => returns Ok(false) without opening a write tx.
        assert!(
            !apply_vendor_usage_scan(
                &pool,
                &[],
                &["/tmp/old.jsonl".to_string(), "/tmp/new.jsonl".to_string()],
                &providers,
                11_000
            )
            .await
            .unwrap()
        );

        let all = VendorUsageSessionRecord::list_since(&pool, 0)
            .await
            .unwrap();
        assert_eq!(all.len(), 2);

        let recent = VendorUsageSessionRecord::list_since(&pool, 3_000)
            .await
            .unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].external_session_id, "sess-new");

        // Removing a vanished file returns Ok(true) and deletes its session.
        assert!(
            apply_vendor_usage_scan(
                &pool,
                &[],
                &["/tmp/new.jsonl".to_string()],
                &providers,
                12_000
            )
            .await
            .unwrap()
        );
        let remaining = VendorUsageSessionRecord::list_since(&pool, 0)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].external_session_id, "sess-new");
    }
}
