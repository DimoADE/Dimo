//! Offline Ed25519 verification of short-lived cloud `HostAccessGrant` tokens.
//!
//! Wire format signed by `dimo-ai.com`:
//!   `grant_token = "<payload_b64url>.<sig_b64url>"`
//!   `signing_input = "dimo-host-grant-v1." + payload_b64url`
//!   `sig = Ed25519.sign(signing_input, cloud_private_key)`
//!
//! Client Proof-of-Possession (PoP):
//!   `pop_input = "dimo-host-grant-pop-v1." + payload.jti + "." + payload.host_id`
//!   `pop_signature = Ed25519.sign(pop_input, client_private_key)`

use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64_STD, URL_SAFE_NO_PAD as BASE64_URL},
};
use db::models::consumed_host_grant::ConsumedHostGrant;
use remote_protocol::DevicePermissionPreset;
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const GRANT_SIGNING_PREFIX: &str = "dimo-host-grant-v1.";
const POP_SIGNING_PREFIX: &str = "dimo-host-grant-pop-v1.";
const CLOCK_SKEW_SECONDS: i64 = 30;
const KEY_CACHE_REFRESH_SECONDS: i64 = 6 * 60 * 60;
const KEY_CACHE_STALE_MAX_SECONDS: i64 = 7 * 24 * 60 * 60;
const KEYS_FILE_NAME: &str = "host-grant-keys.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostGrantPublicKey {
    pub kid: String,
    pub alg: String,
    pub public_key_b64: String,
    #[serde(default)]
    pub not_before: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedKeySet {
    #[serde(default)]
    fetched_at_unix: i64,
    #[serde(default)]
    keys: Vec<HostGrantPublicKey>,
}

#[derive(Debug, Deserialize)]
struct KeysApiResponse {
    keys: Vec<HostGrantPublicKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostAccessGrantPayload {
    pub ver: u32,
    pub kid: String,
    pub jti: String,
    pub account_id: String,
    pub account_username: String,
    pub account_display_name: String,
    pub host_id: String,
    pub client_pubkey: String,
    pub client_kind: String,
    pub preset: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedHostAccessGrant {
    pub jti: String,
    pub account_id: String,
    pub account_username: String,
    pub account_display_name: String,
    pub host_id: String,
    pub client_pubkey_b64: String,
    pub client_kind: String,
    pub preset: DevicePermissionPreset,
    pub exp: i64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GrantVerifyError {
    #[error("this Host is not signed in to a Dimo account")]
    HostSignedOut,
    #[error("malformed host access grant token")]
    MalformedToken,
    #[error("unknown host access grant signing key")]
    UnknownKey,
    #[error("invalid host access grant signature")]
    InvalidSignature,
    #[error("host access grant has expired or is not yet valid")]
    Expired,
    #[error("host access grant targets a different Host")]
    HostMismatch,
    #[error("host access grant belongs to a different Dimo account")]
    AccountMismatch,
    #[error("client public key does not match the signed grant")]
    ClientKeyMismatch,
    #[error("invalid client proof-of-possession signature")]
    InvalidPopSignature,
    #[error("host access grant has already been used")]
    Replayed,
    #[error("host access grant verification keys are unavailable")]
    KeysUnavailable,
    #[error("database error: {0}")]
    Database(String),
}

static KEY_CACHE: LazyLock<RwLock<CachedKeySet>> =
    LazyLock::new(|| RwLock::new(CachedKeySet::default()));

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn cache_file_path() -> PathBuf {
    utils::assets::asset_dir().join(KEYS_FILE_NAME)
}

fn decode_b64_flexible(raw: &str) -> Option<Vec<u8>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    BASE64_URL
        .decode(trimmed)
        .or_else(|_| BASE64_STD.decode(trimmed))
        .ok()
}

fn decode_ed25519_pubkey_32(raw: &str) -> Option<[u8; 32]> {
    let bytes = decode_b64_flexible(raw)?;
    bytes.try_into().ok()
}

async fn load_disk_cache(path: &Path) -> Option<CachedKeySet> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn save_disk_cache(path: &Path, cache: &CachedKeySet) {
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(cache) {
        let _ = tokio::fs::write(path, bytes).await;
    }
}

pub async fn refresh_grant_keys_from_site() -> Result<Vec<HostGrantPublicKey>, GrantVerifyError> {
    let origin = utils::site_origin();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| GrantVerifyError::KeysUnavailable)?;
    let response = client
        .get(format!("{origin}/api/auth/host-grant-keys"))
        .header("user-agent", "Dimo")
        .send()
        .await
        .map_err(|_| GrantVerifyError::KeysUnavailable)?;
    if !response.status().is_success() {
        return Err(GrantVerifyError::KeysUnavailable);
    }
    let body: KeysApiResponse = response
        .json()
        .await
        .map_err(|_| GrantVerifyError::KeysUnavailable)?;
    let now = now_unix();
    let updated = CachedKeySet {
        fetched_at_unix: now,
        keys: body.keys.clone(),
    };
    *KEY_CACHE.write().await = updated.clone();
    save_disk_cache(&cache_file_path(), &updated).await;
    Ok(body.keys)
}

pub async fn get_cached_grant_keys(
    force_refresh: bool,
) -> Result<Vec<HostGrantPublicKey>, GrantVerifyError> {
    let now = now_unix();
    if !force_refresh {
        let mem = KEY_CACHE.read().await.clone();
        if !mem.keys.is_empty() && now - mem.fetched_at_unix < KEY_CACHE_REFRESH_SECONDS {
            return Ok(mem.keys);
        }
        if mem.keys.is_empty()
            && let Some(disk) = load_disk_cache(&cache_file_path()).await
            && !disk.keys.is_empty()
            && now - disk.fetched_at_unix < KEY_CACHE_STALE_MAX_SECONDS
        {
            *KEY_CACHE.write().await = disk.clone();
            if now - disk.fetched_at_unix < KEY_CACHE_REFRESH_SECONDS {
                return Ok(disk.keys);
            }
        }
    }

    match refresh_grant_keys_from_site().await {
        Ok(keys) if !keys.is_empty() => Ok(keys),
        _ => {
            let mem = KEY_CACHE.read().await.clone();
            if !mem.keys.is_empty() && now - mem.fetched_at_unix < KEY_CACHE_STALE_MAX_SECONDS {
                return Ok(mem.keys);
            }
            if let Some(disk) = load_disk_cache(&cache_file_path()).await
                && !disk.keys.is_empty()
                && now - disk.fetched_at_unix < KEY_CACHE_STALE_MAX_SECONDS
            {
                *KEY_CACHE.write().await = disk.clone();
                return Ok(disk.keys);
            }
            Err(GrantVerifyError::KeysUnavailable)
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GrantExpectation<'a> {
    pub host_id: &'a str,
    pub account_id: Option<&'a str>,
    pub account_username: Option<&'a str>,
}

pub fn verify_grant_with_keys(
    grant_token: &str,
    client_pubkey_input: &str,
    pop_signature: &str,
    expected: GrantExpectation<'_>,
    keys: &[HostGrantPublicKey],
    now: i64,
) -> Result<VerifiedHostAccessGrant, GrantVerifyError> {
    let (payload_b64, sig_b64) = grant_token
        .trim()
        .split_once('.')
        .ok_or(GrantVerifyError::MalformedToken)?;
    if payload_b64.is_empty() || sig_b64.is_empty() || sig_b64.contains('.') {
        return Err(GrantVerifyError::MalformedToken);
    }

    let payload_bytes = decode_b64_flexible(payload_b64).ok_or(GrantVerifyError::MalformedToken)?;
    let payload: HostAccessGrantPayload =
        serde_json::from_slice(&payload_bytes).map_err(|_| GrantVerifyError::MalformedToken)?;

    if payload.ver != 1 || payload.jti.trim().is_empty() || payload.kid.trim().is_empty() {
        return Err(GrantVerifyError::MalformedToken);
    }

    let key_record = keys
        .iter()
        .find(|item| item.kid == payload.kid && item.alg.eq_ignore_ascii_case("Ed25519"))
        .ok_or(GrantVerifyError::UnknownKey)?;
    if let Some(nbf) = key_record.not_before
        && now + CLOCK_SKEW_SECONDS < nbf
    {
        return Err(GrantVerifyError::Expired);
    }
    if let Some(exp) = key_record.expires_at
        && now - CLOCK_SKEW_SECONDS > exp
    {
        return Err(GrantVerifyError::Expired);
    }

    let server_pubkey =
        decode_ed25519_pubkey_32(&key_record.public_key_b64).ok_or(GrantVerifyError::UnknownKey)?;
    let sig_bytes = decode_b64_flexible(sig_b64).ok_or(GrantVerifyError::InvalidSignature)?;
    if sig_bytes.len() != 64 {
        return Err(GrantVerifyError::InvalidSignature);
    }

    let signing_input = format!("{GRANT_SIGNING_PREFIX}{payload_b64}");
    UnparsedPublicKey::new(&ED25519, &server_pubkey)
        .verify(signing_input.as_bytes(), &sig_bytes)
        .map_err(|_| GrantVerifyError::InvalidSignature)?;

    if now + CLOCK_SKEW_SECONDS < payload.iat || now - CLOCK_SKEW_SECONDS > payload.exp {
        return Err(GrantVerifyError::Expired);
    }
    if payload.host_id.trim() != expected.host_id.trim() {
        return Err(GrantVerifyError::HostMismatch);
    }

    let account_matched = match (expected.account_id, expected.account_username) {
        (Some(exp_id), _) if !exp_id.trim().is_empty() => {
            payload.account_id.trim() == exp_id.trim()
        }
        (_, Some(exp_user)) if !exp_user.trim().is_empty() => payload
            .account_username
            .trim()
            .eq_ignore_ascii_case(exp_user.trim()),
        _ => return Err(GrantVerifyError::HostSignedOut),
    };
    if !account_matched {
        return Err(GrantVerifyError::AccountMismatch);
    }

    let grant_client_pk = decode_ed25519_pubkey_32(&payload.client_pubkey)
        .ok_or(GrantVerifyError::ClientKeyMismatch)?;
    let presented_client_pk =
        decode_ed25519_pubkey_32(client_pubkey_input).ok_or(GrantVerifyError::ClientKeyMismatch)?;
    if grant_client_pk != presented_client_pk {
        return Err(GrantVerifyError::ClientKeyMismatch);
    }

    let pop_sig_bytes =
        decode_b64_flexible(pop_signature).ok_or(GrantVerifyError::InvalidPopSignature)?;
    if pop_sig_bytes.len() != 64 {
        return Err(GrantVerifyError::InvalidPopSignature);
    }
    let pop_input = format!("{POP_SIGNING_PREFIX}{}.{}", payload.jti, payload.host_id);
    UnparsedPublicKey::new(&ED25519, &grant_client_pk)
        .verify(pop_input.as_bytes(), &pop_sig_bytes)
        .map_err(|_| GrantVerifyError::InvalidPopSignature)?;

    let preset = DevicePermissionPreset::from_command(&payload.preset).unwrap_or_else(|| {
        if payload.client_kind.eq_ignore_ascii_case("mobile") {
            DevicePermissionPreset::Companion
        } else {
            DevicePermissionPreset::Workstation
        }
    });

    let account_display_name = if payload.account_display_name.trim().is_empty() {
        payload.account_username.clone()
    } else {
        payload.account_display_name
    };

    Ok(VerifiedHostAccessGrant {
        jti: payload.jti,
        account_id: payload.account_id,
        account_username: payload.account_username,
        account_display_name,
        host_id: payload.host_id,
        client_pubkey_b64: BASE64_STD.encode(grant_client_pk),
        client_kind: payload.client_kind,
        preset,
        exp: payload.exp,
    })
}

pub async fn verify_and_consume_grant(
    pool: &db::DbPool,
    grant_token: &str,
    client_pubkey_input: &str,
    pop_signature: &str,
    expected_host_id: &str,
    expected_account_id: Option<&str>,
    expected_account_username: Option<&str>,
) -> Result<VerifiedHostAccessGrant, GrantVerifyError> {
    let now = now_unix();
    let expected = GrantExpectation {
        host_id: expected_host_id,
        account_id: expected_account_id,
        account_username: expected_account_username,
    };
    let keys = get_cached_grant_keys(false).await?;
    let verified = match verify_grant_with_keys(
        grant_token,
        client_pubkey_input,
        pop_signature,
        expected,
        &keys,
        now,
    ) {
        Ok(verified) => verified,
        Err(GrantVerifyError::UnknownKey) => {
            let refreshed = get_cached_grant_keys(true).await?;
            verify_grant_with_keys(
                grant_token,
                client_pubkey_input,
                pop_signature,
                expected,
                &refreshed,
                now,
            )?
        }
        Err(error) => return Err(error),
    };

    consume_jti(pool, &verified.jti, verified.exp, now).await?;
    Ok(verified)
}

pub async fn consume_jti(
    pool: &db::DbPool,
    jti: &str,
    expires_at_unix: i64,
    now: i64,
) -> Result<(), GrantVerifyError> {
    let consumed =
        ConsumedHostGrant::try_consume(pool, jti, expires_at_unix, now, CLOCK_SKEW_SECONDS)
            .await
            .map_err(|error| GrantVerifyError::Database(error.to_string()))?;

    if !consumed {
        return Err(GrantVerifyError::Replayed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL};
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    use super::*;

    fn make_signed_grant(
        cloud_kp: &Ed25519KeyPair,
        client_kp: &Ed25519KeyPair,
        payload: &HostAccessGrantPayload,
    ) -> (String, String, String) {
        let payload_b64 = BASE64_URL.encode(serde_json::to_vec(payload).unwrap());
        let signing_input = format!("{GRANT_SIGNING_PREFIX}{payload_b64}");
        let sig_b64 = BASE64_URL.encode(cloud_kp.sign(signing_input.as_bytes()).as_ref());
        let grant_token = format!("{payload_b64}.{sig_b64}");

        let pop_input = format!("{POP_SIGNING_PREFIX}{}.{}", payload.jti, payload.host_id);
        let pop_sig_b64 = BASE64_URL.encode(client_kp.sign(pop_input.as_bytes()).as_ref());
        let client_pub_b64 = BASE64_URL.encode(client_kp.public_key().as_ref());
        (grant_token, client_pub_b64, pop_sig_b64)
    }

    #[tokio::test]
    async fn verifies_valid_grant_and_rejects_replay_wrong_host_wrong_account_and_bad_pop() {
        let rng = SystemRandom::new();
        let cloud_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let cloud_kp = Ed25519KeyPair::from_pkcs8(cloud_pkcs8.as_ref()).unwrap();
        let client_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let client_kp = Ed25519KeyPair::from_pkcs8(client_pkcs8.as_ref()).unwrap();

        let keys = vec![HostGrantPublicKey {
            kid: "dimo-grant-v1".into(),
            alg: "Ed25519".into(),
            public_key_b64: BASE64_URL.encode(cloud_kp.public_key().as_ref()),
            not_before: Some(1_700_000_000),
            expires_at: None,
        }];

        let now = 1_764_000_000;
        let payload = HostAccessGrantPayload {
            ver: 1,
            kid: "dimo-grant-v1".into(),
            jti: "grant-jti-1".into(),
            account_id: "uid-alice".into(),
            account_username: "alice".into(),
            account_display_name: "Alice".into(),
            host_id: "host-mac-1".into(),
            client_pubkey: BASE64_URL.encode(client_kp.public_key().as_ref()),
            client_kind: "desktop".into(),
            preset: "workstation".into(),
            iat: now - 5,
            exp: now + 55,
        };
        let (grant_token, client_pub, pop_sig) = make_signed_grant(&cloud_kp, &client_kp, &payload);

        let expected = GrantExpectation {
            host_id: "host-mac-1",
            account_id: Some("uid-alice"),
            account_username: Some("alice"),
        };

        let verified =
            verify_grant_with_keys(&grant_token, &client_pub, &pop_sig, expected, &keys, now)
                .expect("valid grant should verify");
        assert_eq!(verified.preset, DevicePermissionPreset::Workstation);
        assert_eq!(verified.account_display_name, "Alice");

        // Wrong host
        assert_eq!(
            verify_grant_with_keys(
                &grant_token,
                &client_pub,
                &pop_sig,
                GrantExpectation {
                    host_id: "host-other",
                    ..expected
                },
                &keys,
                now,
            ),
            Err(GrantVerifyError::HostMismatch)
        );

        // Wrong account
        assert_eq!(
            verify_grant_with_keys(
                &grant_token,
                &client_pub,
                &pop_sig,
                GrantExpectation {
                    account_id: Some("uid-bob"),
                    account_username: Some("bob"),
                    ..expected
                },
                &keys,
                now,
            ),
            Err(GrantVerifyError::AccountMismatch)
        );

        // Expired
        assert_eq!(
            verify_grant_with_keys(
                &grant_token,
                &client_pub,
                &pop_sig,
                expected,
                &keys,
                now + 120,
            ),
            Err(GrantVerifyError::Expired)
        );

        // Tampered PoP
        let bad_pop = BASE64_URL.encode([0u8; 64]);
        assert_eq!(
            verify_grant_with_keys(&grant_token, &client_pub, &bad_pop, expected, &keys, now,),
            Err(GrantVerifyError::InvalidPopSignature)
        );

        // Replay protection in SQLite
        let data_dir = tempfile::tempdir().unwrap();
        let db = db::DBService::new_at(data_dir.path()).await.unwrap();
        consume_jti(&db.pool, &verified.jti, verified.exp, now)
            .await
            .expect("first consume succeeds");
        assert_eq!(
            consume_jti(&db.pool, &verified.jti, verified.exp, now).await,
            Err(GrantVerifyError::Replayed)
        );
    }
}
