CREATE TABLE IF NOT EXISTS consumed_host_grants (
    jti TEXT PRIMARY KEY NOT NULL,
    expires_at_unix INTEGER NOT NULL,
    consumed_at_unix INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumed_host_grants_expires
    ON consumed_host_grants (expires_at_unix);
