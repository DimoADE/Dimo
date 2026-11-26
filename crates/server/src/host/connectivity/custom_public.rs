use std::{path::Path, time::Duration};

use chrono::Utc;
use remote_protocol::ReachabilityOrigin;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::validate_remote_base_url;

const SETTINGS_SECTION: &str = "custom_public_origins";
const SELF_CHECK_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_CUSTOM_PUBLIC_ORIGINS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomPublicOriginRecord {
    pub id: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CustomPublicOriginStore {
    #[serde(default)]
    items: Vec<CustomPublicOriginRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomPublicOriginCheck {
    pub origin: String,
    pub reachable: bool,
    pub host_id_matched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reported_host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeHealthPayload {
    status: Option<String>,
    ok: Option<bool>,
    host_id: Option<String>,
}

async fn load_store_at(settings_path: &Path) -> Result<CustomPublicOriginStore, String> {
    services::services::settings_store::read_section(settings_path, SETTINGS_SECTION)
        .await
        .map_err(|error| error.to_string())
        .map(|value| value.unwrap_or_default())
}

async fn save_store_at(
    settings_path: &Path,
    store: &CustomPublicOriginStore,
) -> Result<(), String> {
    services::services::settings_store::write_section(settings_path, SETTINGS_SECTION, store)
        .await
        .map_err(|error| error.to_string())
}

pub async fn list_custom_public_origins() -> Vec<CustomPublicOriginRecord> {
    load_store_at(&utils::assets::settings_path())
        .await
        .map(|store| store.items)
        .unwrap_or_default()
}

pub async fn custom_public_reachability() -> Vec<ReachabilityOrigin> {
    list_custom_public_origins()
        .await
        .into_iter()
        .map(|item| ReachabilityOrigin::custom_public(item.origin))
        .collect()
}

fn is_forbidden_custom_public_host(origin: &str) -> bool {
    if remote_protocol::is_loopback_origin(origin) {
        return true;
    }
    let Ok(parsed) = url::Url::parse(origin) else {
        return true;
    };
    let Some(host) = parsed.host() else {
        return true;
    };
    match host {
        url::Host::Ipv4(v4) => v4.is_loopback() || v4.is_unspecified() || v4.is_link_local(),
        url::Host::Ipv6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            if let Some(mapped) = v6.to_ipv4_mapped()
                && (mapped.is_loopback() || mapped.is_unspecified() || mapped.is_link_local())
            {
                return true;
            }
            // fe80::/10 link-local IPv6
            (v6.segments()[0] & 0xffc0) == 0xfe80
        }
        url::Host::Domain(domain) => {
            let lower = domain.trim_end_matches('.').to_ascii_lowercase();
            lower == "localhost"
                || lower.ends_with(".localhost")
                || lower == "metadata.google.internal"
        }
    }
}

pub fn normalize_custom_public_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Public URL is required".to_string());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let normalized = validate_remote_base_url(&candidate)?;
    if is_forbidden_custom_public_host(&normalized) {
        return Err(
            "Custom public origin cannot target loopback, unspecified, or link-local metadata addresses"
                .to_string(),
        );
    }
    Ok(normalized)
}

pub async fn probe_custom_public_origin(
    raw_origin: &str,
    expected_host_id: Option<&str>,
) -> Result<CustomPublicOriginCheck, String> {
    let origin = normalize_custom_public_origin(raw_origin)?;
    let warning = remote_protocol::is_public_plaintext_http_origin(&origin).then(|| {
        "Plaintext HTTP on a public address exposes traffic unless wrapped in TLS or E2EE."
            .to_string()
    });
    let client = reqwest::Client::builder()
        .timeout(SELF_CHECK_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let health_url = format!("{origin}/health");
    let response = match client.get(&health_url).send().await {
        Ok(resp) => resp,
        Err(error) => {
            return Ok(CustomPublicOriginCheck {
                origin,
                reachable: false,
                host_id_matched: false,
                reported_host_id: None,
                warning,
                error: Some(format!("Could not reach {health_url}: {error}")),
            });
        }
    };
    if !response.status().is_success() {
        return Ok(CustomPublicOriginCheck {
            origin,
            reachable: false,
            host_id_matched: false,
            reported_host_id: None,
            warning,
            error: Some(format!(
                "{health_url} returned HTTP {}",
                response.status().as_u16()
            )),
        });
    }
    let payload: ProbeHealthPayload = match response.json().await {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(CustomPublicOriginCheck {
                origin,
                reachable: false,
                host_id_matched: false,
                reported_host_id: None,
                warning,
                error: Some(format!(
                    "{health_url} did not return a Dimo Host health payload: {error}"
                )),
            });
        }
    };
    let healthy = payload.status.as_deref() == Some("ok") || payload.ok == Some(true);
    if !healthy {
        return Ok(CustomPublicOriginCheck {
            origin,
            reachable: false,
            host_id_matched: false,
            reported_host_id: payload.host_id,
            warning,
            error: Some("Endpoint responded, but did not report healthy Dimo Host status".into()),
        });
    }
    let expected = expected_host_id.map(str::trim).filter(|v| !v.is_empty());
    let matched = match (expected, payload.host_id.as_deref()) {
        (Some(exp), Some(actual)) => exp == actual,
        (Some(_), None) => false,
        (None, _) => true,
    };
    let error = (!matched).then(|| {
        "Endpoint reached a different Dimo Host than this machine. Check your reverse proxy or tunnel target."
            .to_string()
    });
    Ok(CustomPublicOriginCheck {
        origin,
        reachable: true,
        host_id_matched: matched,
        reported_host_id: payload.host_id,
        warning,
        error,
    })
}

pub async fn add_custom_public_origin(
    raw_origin: &str,
    label: Option<String>,
    expected_host_id: Option<&str>,
    skip_probe: bool,
) -> Result<(CustomPublicOriginRecord, Option<CustomPublicOriginCheck>), String> {
    let normalized = normalize_custom_public_origin(raw_origin)?;
    let check = if skip_probe {
        None
    } else {
        let probe = probe_custom_public_origin(&normalized, expected_host_id).await?;
        if !probe.reachable || !probe.host_id_matched {
            return Err(probe
                .error
                .unwrap_or_else(|| "Custom public origin failed health verification".to_string()));
        }
        Some(probe)
    };
    let settings_path = utils::assets::settings_path();
    let record = add_custom_public_origin_at(&settings_path, &normalized, label).await?;
    Ok((record, check))
}

pub async fn add_custom_public_origin_at(
    settings_path: &Path,
    normalized_origin: &str,
    label: Option<String>,
) -> Result<CustomPublicOriginRecord, String> {
    let mut store = load_store_at(settings_path).await?;
    let clean_label = label
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if let Some(existing) = store
        .items
        .iter_mut()
        .find(|item| item.origin.eq_ignore_ascii_case(normalized_origin))
    {
        if clean_label.is_some() {
            existing.label = clean_label;
        }
        let cloned = existing.clone();
        save_store_at(settings_path, &store).await?;
        return Ok(cloned);
    }
    if store.items.len() >= MAX_CUSTOM_PUBLIC_ORIGINS {
        return Err(format!(
            "At most {MAX_CUSTOM_PUBLIC_ORIGINS} custom public origins can be saved"
        ));
    }
    let record = CustomPublicOriginRecord {
        id: Uuid::new_v4().to_string(),
        origin: normalized_origin.to_string(),
        label: clean_label,
        created_at: Utc::now().to_rfc3339(),
    };
    store.items.push(record.clone());
    save_store_at(settings_path, &store).await?;
    Ok(record)
}

pub async fn remove_custom_public_origin(id: &str) -> Result<Vec<CustomPublicOriginRecord>, String> {
    remove_custom_public_origin_at(&utils::assets::settings_path(), id).await
}

pub async fn remove_custom_public_origin_at(
    settings_path: &Path,
    id: &str,
) -> Result<Vec<CustomPublicOriginRecord>, String> {
    let mut store = load_store_at(settings_path).await?;
    let target = id.trim();
    store
        .items
        .retain(|item| item.id != target && !item.origin.eq_ignore_ascii_case(target));
    save_store_at(settings_path, &store).await?;
    Ok(store.items)
}

#[cfg(test)]
mod tests {
    use super::{
        add_custom_public_origin_at, load_store_at, normalize_custom_public_origin,
        remove_custom_public_origin_at,
    };

    #[test]
    fn normalizes_and_rejects_loopback_custom_public_origin() {
        assert_eq!(
            normalize_custom_public_origin("dev.example.com/dimo/").unwrap(),
            "https://dev.example.com/dimo"
        );
        assert_eq!(
            normalize_custom_public_origin("https://box.tail1234.ts.net/").unwrap(),
            "https://box.tail1234.ts.net"
        );
        assert!(normalize_custom_public_origin("http://127.0.0.1:17891").is_err());
        assert!(normalize_custom_public_origin("http://localhost:17891").is_err());
    }

    #[tokio::test]
    async fn persists_deduplicates_and_removes_custom_public_origins() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");

        let first = add_custom_public_origin_at(
            &settings,
            "https://dev.example.com/dimo",
            Some("Cloudflare Tunnel".into()),
        )
        .await
        .unwrap();
        let dup = add_custom_public_origin_at(
            &settings,
            "https://dev.example.com/dimo",
            Some("Updated".into()),
        )
        .await
        .unwrap();
        assert_eq!(first.id, dup.id);
        assert_eq!(dup.label.as_deref(), Some("Updated"));

        let loaded = load_store_at(&settings).await.unwrap();
        assert_eq!(loaded.items.len(), 1);

        let remaining = remove_custom_public_origin_at(&settings, &first.id)
            .await
            .unwrap();
        assert!(remaining.is_empty());
    }
}
