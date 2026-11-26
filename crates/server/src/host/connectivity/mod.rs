pub mod account_daemon;
pub mod custom_public;
pub mod e2ee_client;
pub mod grant_verifier;
pub mod routes;

use url::Url;

/// Validates a remote Host base URL used by Desktop clients, custom public origins,
/// and tunnel endpoints.
///
/// Allows clean path prefixes such as `/t/<host_id>` (official and self-hosted relays)
/// and reverse-proxy subpaths such as `/dimo`, while rejecting credentials, query
/// parameters, fragments, non-HTTP(S) schemes, and path traversal segments.
pub fn validate_remote_base_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Host URL is required".to_string());
    }
    if let Some((_, after_scheme)) = trimmed.split_once("://") {
        let before_query = after_scheme
            .split(['?', '#'])
            .next()
            .unwrap_or(after_scheme);
        if let Some((_, raw_path)) = before_query.split_once('/') {
            for segment in raw_path.split('/') {
                let lowered = segment.to_ascii_lowercase();
                if matches!(
                    lowered.as_str(),
                    "." | ".." | "%2e" | "%2e%2e" | ".%2e" | "%2e."
                ) {
                    return Err("remote Server URL path must not contain dot segments".to_string());
                }
            }
        }
    }
    let url = Url::parse(trimmed).map_err(|error| format!("invalid Server URL: {error}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("remote Server URL must use HTTP or HTTPS".to_string());
    }
    if url.host_str().is_none() {
        return Err("remote Server URL must include a host".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "remote Server URL must not contain credentials, query parameters, or fragments"
                .to_string(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Extracts `scheme://host[:port]` browser Origin header value from a base URL
/// (which may contain a path prefix like `/t/<host_id>` or `/dimo`).
pub fn browser_origin_of(base_url: &str) -> Option<String> {
    let url = Url::parse(base_url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    let host_part = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    match url.port() {
        Some(port) => Some(format!("{}://{host_part}:{port}", url.scheme())),
        None => Some(format!("{}://{host_part}", url.scheme())),
    }
}

#[cfg(test)]
mod tests {
    use super::{browser_origin_of, validate_remote_base_url};

    #[test]
    fn validates_origins_and_clean_path_prefixes() {
        assert_eq!(
            validate_remote_base_url("https://relay.dimo-ai.com/t/host_abc/").unwrap(),
            "https://relay.dimo-ai.com/t/host_abc"
        );
        assert_eq!(
            validate_remote_base_url("https://dev.example.com/dimo").unwrap(),
            "https://dev.example.com/dimo"
        );
        assert_eq!(
            validate_remote_base_url("http://192.168.1.20:17891/").unwrap(),
            "http://192.168.1.20:17891"
        );
        assert!(validate_remote_base_url("ftp://example.com").is_err());
        assert!(validate_remote_base_url("https://user@example.com/t/abc").is_err());
        assert!(validate_remote_base_url("https://example.com/t/abc?foo=1").is_err());
        assert!(validate_remote_base_url("https://example.com/t/abc#frag").is_err());
    }

    #[test]
    fn extracts_browser_origin_without_path() {
        assert_eq!(
            browser_origin_of("https://relay.dimo-ai.com/t/host_abc").as_deref(),
            Some("https://relay.dimo-ai.com")
        );
        assert_eq!(
            browser_origin_of("http://203.0.113.10:13630/t/host_abc").as_deref(),
            Some("http://203.0.113.10:13630")
        );
    }
}
