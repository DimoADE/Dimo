use sqlx::SqlitePool;

/// Replay-protection ledger for one-time Ed25519 `HostAccessGrant` tokens (`consumed_host_grants`).
pub struct ConsumedHostGrant;

impl ConsumedHostGrant {
    /// Prunes expired grant IDs and atomically records `jti`.
    /// Returns `Ok(true)` if newly consumed, or `Ok(false)` if `jti` was already redeemed.
    pub async fn try_consume(
        pool: &SqlitePool,
        jti: &str,
        expires_at_unix: i64,
        now_unix: i64,
        clock_skew_seconds: i64,
    ) -> Result<bool, sqlx::Error> {
        let _ = sqlx::query("DELETE FROM consumed_host_grants WHERE expires_at_unix < ?")
            .bind(now_unix - clock_skew_seconds)
            .execute(pool)
            .await;

        let result = sqlx::query(
            "INSERT OR IGNORE INTO consumed_host_grants (jti, expires_at_unix, consumed_at_unix)
             VALUES (?, ?, ?)",
        )
        .bind(jti)
        .bind(expires_at_unix)
        .bind(now_unix)
        .execute(pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }
}
