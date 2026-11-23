use sqlx::{Acquire, SqliteConnection, SqlitePool};

use crate::models::agent_management::legacy_migration::LegacyAgentMigration;

/// Removes user rows from the local database.
///
/// `conversation_fts` is an FTS5 index. Deleting its shadow rows also deletes
/// the structure record (`%_data` rowid 10). SQLite 3.46 then refuses to open
/// the table: `xConnect` returns `SQLITE_CORRUPT_VTAB` (267) and does not set
/// an error string, so the core reports `vtable constructor failed`.
/// `DROP TABLE` has to open that constructor, so it fails the same way.
/// Remove the virtual table and its shadow tables from `sqlite_master`
/// without calling the constructor, recreate the empty index, then delete the
/// ordinary rows.
pub async fn clear_local_database_rows(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await?;

    let clear_result: Result<(), sqlx::Error> = async {
        let virtual_tables: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, sql FROM sqlite_master \
             WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
        )
        .fetch_all(&mut *connection)
        .await?;
        excise_virtual_tables(&mut connection, &virtual_tables).await?;

        let mut tx = connection.begin().await?;
        let table_names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_sqlx_migrations'",
        )
        .fetch_all(&mut *tx)
        .await?;
        for table_name in table_names {
            if is_virtual_or_shadow(&table_name, &virtual_tables) {
                continue;
            }
            let escaped = table_name.replace('"', "\"\"");
            let statement = format!("DELETE FROM \"{escaped}\"");
            sqlx::query(&statement).execute(&mut *tx).await?;
        }
        let _ = sqlx::query("DELETE FROM sqlite_sequence")
            .execute(&mut *tx)
            .await;
        tx.commit().await?;

        // Recreate only after the row deletes. Those deletes must not run
        // against the new shadow tables, or the structure record disappears
        // and the next open fails with code 267 again.
        for (_, create_sql) in &virtual_tables {
            sqlx::query(create_sql).execute(&mut *connection).await?;
        }
        Ok(())
    }
    .await;

    let restore_result = sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await;
    if clear_result.is_err() || restore_result.is_err() {
        connection.close_on_drop();
    }
    clear_result?;
    restore_result?;
    drop(connection);
    reload_idle_schemas(pool).await;

    let _ = sqlx::query("VACUUM").execute(pool).await;
    Ok(())
}

pub async fn reset_local_database(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    clear_local_database_rows(pool).await?;
    LegacyAgentMigration::run(pool)
        .await
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    Ok(())
}

/// Detects FTS5 virtual tables whose shadow tables are corrupt (for example
/// missing `conversation_fts_data` rowid 10 after a legacy v0.2.x local-data
/// reset) and rebuilds them empty before migrations or queries attempt
/// `DROP TABLE` / `SELECT`, which would otherwise fail in SQLite 3.46 with
/// `SQLITE_CORRUPT_VTAB` (267).
pub(crate) async fn repair_corrupt_fts_virtual_tables(
    pool: &SqlitePool,
) -> Result<Vec<String>, sqlx::Error> {
    let mut connection = pool.acquire().await?;
    let fts_tables: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, sql FROM sqlite_master \
         WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
    )
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .filter(|(_, sql): &(String, String)| sql.to_ascii_lowercase().contains("using fts5"))
    .collect();

    if fts_tables.is_empty() {
        return Ok(Vec::new());
    }

    let mut corrupt = Vec::new();
    for (name, create_sql) in fts_tables {
        let escaped = name.replace('"', "\"\"");
        let probe = format!("SELECT rowid FROM \"{escaped}\" LIMIT 1");
        match sqlx::query_scalar::<_, i64>(&probe)
            .persistent(false)
            .fetch_optional(&mut *connection)
            .await
        {
            Ok(_) => {}
            Err(error) if is_corrupt_fts5_error(&error) => {
                tracing::warn!(
                    table = %name,
                    %error,
                    "detected corrupt FTS5 virtual table; excising and recreating empty index"
                );
                corrupt.push((name, create_sql));
            }
            Err(error) => return Err(error),
        }
    }

    if corrupt.is_empty() {
        return Ok(Vec::new());
    }

    let repair_result: Result<(), sqlx::Error> = async {
        excise_virtual_tables(&mut connection, &corrupt).await?;
        for (_, create_sql) in &corrupt {
            sqlx::query(create_sql)
                .persistent(false)
                .execute(&mut *connection)
                .await?;
        }
        Ok(())
    }
    .await;

    if repair_result.is_err() {
        connection.close_on_drop();
    }
    repair_result?;
    drop(connection);

    reload_idle_schemas(pool).await;
    // Reclaim unreferenced B-tree pages left behind by direct sqlite_master deletion.
    let _ = sqlx::query("VACUUM").execute(pool).await;

    Ok(corrupt.into_iter().map(|(name, _)| name).collect())
}

fn is_corrupt_fts5_error(error: &sqlx::Error) -> bool {
    let Some(db_err) = error.as_database_error() else {
        return false;
    };
    if matches!(db_err.code().as_deref(), Some("11" | "267")) {
        return true;
    }
    let message = db_err.message().to_ascii_lowercase();
    message.contains("vtable constructor failed")
        || message.contains("database disk image is malformed")
        || message.contains("fts5:")
        || message.contains("no such table:")
}

async fn excise_virtual_tables(
    connection: &mut SqliteConnection,
    virtual_tables: &[(String, String)],
) -> Result<(), sqlx::Error> {
    if virtual_tables.is_empty() {
        return Ok(());
    }
    sqlx::query("PRAGMA writable_schema = ON")
        .execute(&mut *connection)
        .await?;
    let mut removed = Ok(());
    for (table_name, _) in virtual_tables {
        if removed.is_err() {
            break;
        }
        removed = sqlx::query(
            "DELETE FROM sqlite_master \
             WHERE name = ?1 OR tbl_name = ?1 OR name GLOB ?2 OR tbl_name GLOB ?2",
        )
        .bind(table_name)
        .bind(shadow_glob(table_name))
        .execute(&mut *connection)
        .await
        .map(|_| ());
    }
    let reset = sqlx::query("PRAGMA writable_schema = RESET")
        .execute(&mut *connection)
        .await;
    removed?;
    reset?;
    Ok(())
}

fn is_virtual_or_shadow(name: &str, virtual_tables: &[(String, String)]) -> bool {
    const SUFFIXES: [&str; 5] = ["_data", "_idx", "_content", "_docsize", "_config"];
    virtual_tables.iter().any(|(virtual_name, _)| {
        name == virtual_name
            || SUFFIXES
                .iter()
                .any(|suffix| name == format!("{virtual_name}{suffix}"))
    })
}

/// `LIKE` treats `_` as a wildcard. Shadow tables are `{name}_data` and the
/// other FTS5 suffixes, so match them with a `GLOB` instead.
fn shadow_glob(table_name: &str) -> String {
    let mut pattern = String::new();
    for character in table_name.chars() {
        if matches!(character, '*' | '?' | '[' | ']') {
            pattern.push('[');
            pattern.push(character);
            pattern.push(']');
        } else {
            pattern.push(character);
        }
    }
    pattern.push_str("_*");
    pattern
}

async fn reload_idle_schemas(pool: &SqlitePool) {
    let idle = pool.num_idle();
    for _ in 0..idle {
        let Ok(Ok(mut connection)) =
            tokio::time::timeout(std::time::Duration::from_millis(200), pool.acquire()).await
        else {
            break;
        };
        let _ = sqlx::query("PRAGMA writable_schema = RESET")
            .execute(&mut *connection)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };

    use super::{clear_local_database_rows, reset_local_database};

    async fn reopen(temp: &tempfile::TempDir) -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(temp.path().join("reset.sqlite")))
            .await
            .unwrap()
    }

    async fn seeded_pool() -> (tempfile::TempDir, SqlitePool) {
        let temp = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(temp.path().join("reset.sqlite"))
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE durable_data(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO durable_data(value) VALUES('must be cleared')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE VIRTUAL TABLE conversation_fts USING fts5(\
             body, conversation_id UNINDEXED, workspace_id UNINDEXED, \
             title UNINDEXED, tokenize = 'trigram')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_fts(body, conversation_id, workspace_id, title) \
             VALUES('searchable text', 'conversation', 'workspace', 'title')",
        )
        .execute(&pool)
        .await
        .unwrap();
        (temp, pool)
    }

    async fn assert_database_was_cleared(pool: &SqlitePool) {
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM durable_data")
                .fetch_one(pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM conversation_fts")
                .fetch_one(pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(pool)
                .await
                .unwrap(),
            "ok"
        );
    }

    #[tokio::test]
    async fn local_data_clear_rebuilds_an_intact_fts_index() {
        let (_temp, pool) = seeded_pool().await;
        clear_local_database_rows(&pool).await.unwrap();
        assert_database_was_cleared(&pool).await;
    }

    #[tokio::test]
    async fn local_data_clear_recovers_shadow_tables_emptied_by_a_naive_reset() {
        let (temp, pool) = seeded_pool().await;
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'conversation_fts%'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        for name in tables {
            if name == "conversation_fts" {
                continue;
            }
            let statement = format!("DELETE FROM \"{name}\"");
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        // The connection that created the index still has it open, so DROP
        // skips xConnect. The user's database is opened later, and SQLite
        // 3.46 then fails the constructor with code 267.
        pool.close().await;
        let pool = reopen(&temp).await;
        clear_local_database_rows(&pool).await.unwrap();
        assert_database_was_cleared(&pool).await;
    }

    #[tokio::test]
    async fn local_data_clear_recovers_a_partially_cleared_fts_index() {
        let (_temp, pool) = seeded_pool().await;
        sqlx::query("DELETE FROM conversation_fts_content")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM conversation_fts_docsize")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM conversation_fts_config")
            .execute(&pool)
            .await
            .unwrap();
        clear_local_database_rows(&pool).await.unwrap();
        assert_database_was_cleared(&pool).await;
    }

    #[tokio::test]
    async fn local_data_reset_restores_the_built_in_agent_catalog() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        reset_local_database(&pool).await.unwrap();

        let agent_ids = sqlx::query_scalar::<_, String>(
            "SELECT agent_id FROM agent_membership ORDER BY position, agent_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let expected: Vec<String> = api_types::AgentKind::built_in_bar_order()
            .map(|kind| kind.as_str().to_string())
            .collect();
        assert_eq!(agent_ids, expected);
    }
}
