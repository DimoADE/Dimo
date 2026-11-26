//! Persistent Ed25519 client identity for Desktop Host-Client Proof-of-Possession (PoP).
//!
//! Used when exchanging an account-issued `HostAccessGrant` at
//! `POST /api/v1/auth/grant-exchange` and when identifying this client device to Hosts.

use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::{Deserialize, Serialize};

use super::super::error::DesktopError;

const IDENTITY_FILE_NAME: &str = "client-identity.json";
const POP_DOMAIN_PREFIX: &str = "dimo-host-grant-pop-v1.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredClientIdentity {
    pkcs8_b64: String,
    public_key_ed25519: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientIdentityView {
    pub public_key_ed25519: String,
}

fn identity_file_path() -> PathBuf {
    utils::assets::asset_dir().join(IDENTITY_FILE_NAME)
}

fn load_or_create_keypair_at(path: &Path) -> Result<(Ed25519KeyPair, String), DesktopError> {
    if let Ok(raw) = std::fs::read_to_string(path)
        && let Ok(stored) = serde_json::from_str::<StoredClientIdentity>(&raw)
        && let Ok(pkcs8) = BASE64_URL.decode(stored.pkcs8_b64.trim())
        && let Ok(kp) = Ed25519KeyPair::from_pkcs8(&pkcs8)
    {
        let pub_b64 = BASE64_URL.encode(kp.public_key().as_ref());
        return Ok((kp, pub_b64));
    }

    let rng = SystemRandom::new();
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
        .map_err(|_| DesktopError::Internal("failed to generate client Ed25519 keypair".into()))?;
    let kp = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        .map_err(|_| DesktopError::Internal("failed to load generated Ed25519 keypair".into()))?;
    let pub_b64 = BASE64_URL.encode(kp.public_key().as_ref());

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stored = StoredClientIdentity {
        pkcs8_b64: BASE64_URL.encode(pkcs8.as_ref()),
        public_key_ed25519: pub_b64.clone(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&stored) {
        let _ = std::fs::write(path, json);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }

    Ok((kp, pub_b64))
}

pub fn load_client_identity_view() -> Result<ClientIdentityView, DesktopError> {
    let (_, public_key_ed25519) = load_or_create_keypair_at(&identity_file_path())?;
    Ok(ClientIdentityView { public_key_ed25519 })
}

pub fn sign_host_grant_pop(jti: &str, host_id: &str) -> Result<(String, String), DesktopError> {
    sign_host_grant_pop_at(&identity_file_path(), jti, host_id)
}

pub(crate) fn sign_host_grant_pop_at(
    path: &Path,
    jti: &str,
    host_id: &str,
) -> Result<(String, String), DesktopError> {
    let (kp, pub_b64) = load_or_create_keypair_at(path)?;
    let msg = format!("{POP_DOMAIN_PREFIX}{jti}.{host_id}");
    let sig = kp.sign(msg.as_bytes());
    Ok((pub_b64, BASE64_URL.encode(sig.as_ref())))
}

fn decode_b64_flexible(input: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE};
    let trimmed = input.trim();
    BASE64_URL
        .decode(trimmed)
        .or_else(|_| URL_SAFE.decode(trimmed))
        .or_else(|_| STANDARD_NO_PAD.decode(trimmed))
        .or_else(|_| STANDARD.decode(trimmed))
        .ok()
}

pub fn extract_grant_jti(grant_token: &str) -> Result<String, DesktopError> {
    let parts: Vec<&str> = grant_token.trim().split('.').collect();
    let payload_b64 = match parts.as_slice() {
        [payload, _sig] => *payload,
        ["dimo-host-grant-v1", payload, _sig] => *payload,
        _ => {
            return Err(DesktopError::BadRequest(
                "invalid host access grant token".into(),
            ));
        }
    };
    let payload_bytes = decode_b64_flexible(payload_b64)
        .ok_or_else(|| DesktopError::BadRequest("invalid host access grant payload".into()))?;
    let payload: serde_json::Value = serde_json::from_slice(&payload_bytes)
        .map_err(|_| DesktopError::BadRequest("invalid host access grant JSON".into()))?;
    payload
        .get("jti")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| DesktopError::BadRequest("host access grant missing jti".into()))
}
