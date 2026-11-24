use url::{Host, Url};

/// Syntactic policy shared by manifest resolution and the authoritative
/// installer boundary. DNS answers are checked separately by `HttpDownloader`.
pub fn validate_distribution_url(value: &str) -> Result<(), &'static str> {
    let url = Url::parse(value).map_err(|_| "download URL is invalid")?;
    let host = match url.host() {
        Some(Host::Domain(host)) => host.trim_end_matches('.'),
        _ => return Err("download URL must use a DNS host"),
    };
    let blocked_suffix = [
        "localhost",
        "local",
        "localdomain",
        "internal",
        "home",
        "lan",
        "test",
        "invalid",
    ]
    .iter()
    .any(|suffix| host.eq_ignore_ascii_case(suffix) || host.ends_with(&format!(".{suffix}")));
    if url.scheme() != "https"
        || host.is_empty()
        || host.len() != url.host_str().map_or(0, str::len)
        || blocked_suffix
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "download URL must use HTTPS with a public DNS host and no credentials, query, or fragment",
        );
    }
    Ok(())
}
