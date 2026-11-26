//! Rust E2EE v1 client matching `crates/server/src/e2ee.rs` and `crates/server/src/ws.rs`.
//!
//! Used by `RemoteDesktopRegistry` so Desktop <-> Remote Host traffic over relays and
//! untrusted networks is end-to-end encrypted with ephemeral ECDH P-256 + HKDF-SHA256
//! + AES-256-GCM.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use ring::{
    agreement::{ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, agree_ephemeral},
    rand::SystemRandom,
};

use crate::e2ee::{
    AAD_AUTH, AAD_REQ, AAD_RESP, AAD_WS, E2EE_VERSION, HEADER_E2EE, HEADER_E2EE_AUTH,
    HEADER_E2EE_CLIENT_PUB, HEADER_E2EE_SERVER_PUB, HEADER_E2EE_SESSION, decrypt_payload,
    derive_aes256_key, encrypt_payload,
};

#[derive(Clone)]
pub struct E2eeClientSession {
    pub session_id: String,
    pub key: [u8; 32],
    pub client_pub_b64: String,
}

impl std::fmt::Debug for E2eeClientSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("E2eeClientSession")
            .field("session_id", &self.session_id)
            .field("key", &"[REDACTED]")
            .finish()
    }
}

pub async fn handshake(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<E2eeClientSession, String> {
    let rng = SystemRandom::new();
    let client_priv = EphemeralPrivateKey::generate(&ECDH_P256, &rng)
        .map_err(|_| "failed to generate E2EE P-256 keypair".to_string())?;
    let client_pub = client_priv
        .compute_public_key()
        .map_err(|_| "failed to compute E2EE public key".to_string())?;
    let client_pub_b64 = BASE64.encode(client_pub.as_ref());

    let url = format!("{}/api/v1/e2ee/handshake", base_url.trim_end_matches('/'));
    let response = client
        .get(&url)
        .header(HEADER_E2EE_CLIENT_PUB, &client_pub_b64)
        .send()
        .await
        .map_err(|error| format!("E2EE handshake request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "E2EE handshake returned HTTP {}",
            response.status().as_u16()
        ));
    }

    let session_id = response
        .headers()
        .get(HEADER_E2EE_SESSION)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "remote Host did not return x-dimo-e2ee-session".to_string())?
        .to_string();
    let server_pub_b64 = response
        .headers()
        .get(HEADER_E2EE_SERVER_PUB)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "remote Host did not return x-dimo-e2ee-server-pub".to_string())?
        .to_string();

    let server_pub_bytes = BASE64
        .decode(&server_pub_b64)
        .map_err(|_| "invalid server E2EE public key encoding".to_string())?;
    let key = agree_ephemeral(
        client_priv,
        &UnparsedPublicKey::new(&ECDH_P256, &server_pub_bytes),
        derive_aes256_key,
    )
    .map_err(|_| "E2EE ECDH key agreement failed".to_string())?;

    Ok(E2eeClientSession {
        session_id,
        key,
        client_pub_b64,
    })
}

pub fn build_encrypted_headers(
    session: &E2eeClientSession,
    bearer_token: Option<&str>,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static(HEADER_E2EE),
        HeaderValue::from_static(E2EE_VERSION),
    );
    headers.insert(
        HeaderName::from_static(HEADER_E2EE_SESSION),
        HeaderValue::from_str(&session.session_id).map_err(|e| e.to_string())?,
    );
    headers.insert(
        HeaderName::from_static(HEADER_E2EE_CLIENT_PUB),
        HeaderValue::from_str(&session.client_pub_b64).map_err(|e| e.to_string())?,
    );
    if let Some(token) = bearer_token {
        let auth_plaintext = format!("Bearer {token}");
        let enc_auth = encrypt_payload(&session.key, AAD_AUTH, auth_plaintext.as_bytes())
            .map_err(str::to_string)?;
        headers.insert(
            HeaderName::from_static(HEADER_E2EE_AUTH),
            HeaderValue::from_str(&enc_auth).map_err(|e| e.to_string())?,
        );
    }
    headers.remove(AUTHORIZATION);
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    Ok(headers)
}

pub fn encrypt_request_body(
    session: &E2eeClientSession,
    plaintext: &[u8],
) -> Result<String, String> {
    encrypt_payload(&session.key, AAD_REQ, plaintext).map_err(str::to_string)
}

pub fn decrypt_response_bytes(
    session: &E2eeClientSession,
    headers: &HeaderMap,
    raw_body: &[u8],
) -> Result<Vec<u8>, String> {
    let is_e2ee = headers
        .get(HEADER_E2EE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case(E2EE_VERSION));
    if !is_e2ee || raw_body.is_empty() {
        return Ok(raw_body.to_vec());
    }
    let encoded = std::str::from_utf8(raw_body)
        .map_err(|_| "E2EE response body was not valid UTF-8".to_string())?;
    decrypt_payload(&session.key, AAD_RESP, encoded.trim()).map_err(str::to_string)
}

pub fn encrypt_ws_text(session: &E2eeClientSession, plaintext_json: &str) -> Result<String, String> {
    let cipher = encrypt_payload(&session.key, AAD_WS, plaintext_json.as_bytes())
        .map_err(str::to_string)?;
    Ok(serde_json::json!({
        "type": "e2ee",
        "d": cipher,
    })
    .to_string())
}

pub fn decrypt_ws_text(session: &E2eeClientSession, wire_text: &str) -> Result<String, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(wire_text).map_err(|e| format!("invalid WS JSON frame: {e}"))?;
    if parsed.get("type").and_then(|v| v.as_str()) == Some("e2ee") {
        let cipher = parsed
            .get("d")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing E2EE WS ciphertext field".to_string())?;
        let plain = decrypt_payload(&session.key, AAD_WS, cipher).map_err(str::to_string)?;
        return String::from_utf8(plain).map_err(|e| format!("invalid E2EE WS UTF-8: {e}"));
    }
    Err("expected encrypted E2EE WebSocket frame".to_string())
}

pub fn ws_e2ee_subprotocol(session: &E2eeClientSession) -> String {
    format!("dimo.e2ee.{}", session.session_id)
}
