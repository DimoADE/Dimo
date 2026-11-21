/// The current application version from Cargo.toml
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Runtime application version, preferring `DIMO_APP_VERSION` (set from `--app-version`
/// by the desktop shell) and falling back to the compile-time [`APP_VERSION`].
pub fn runtime_app_version() -> String {
    let env_value = std::env::var("DIMO_APP_VERSION").ok();
    resolve_runtime_app_version(env_value.as_deref())
}

fn resolve_runtime_app_version(override_value: Option<&str>) -> String {
    override_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| APP_VERSION.to_string())
}

pub fn normalize(version: &str) -> &str {
    version.trim().trim_start_matches('v')
}

/// True when `latest` is a higher dotted numeric version than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        normalize(version)
            .split('.')
            .filter_map(|part| {
                let digits: String = part.chars().take_while(|ch| ch.is_ascii_digit()).collect();
                digits.parse().ok()
            })
            .collect()
    }
    let latest = parts(latest);
    let current = parts(current);
    if latest.is_empty() || current.is_empty() {
        return false;
    }
    latest > current
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_are_detected() {
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(is_newer("v0.3.0", "0.2.9"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
        assert!(!is_newer("", "0.2.0"));
        assert!(!is_newer("0.2.1", ""));
    }

    #[test]
    fn runtime_app_version_prefers_non_empty_override() {
        assert_eq!(resolve_runtime_app_version(Some(" 0.9.1 ")), "0.9.1");
        assert_eq!(resolve_runtime_app_version(Some("   ")), APP_VERSION);
        assert_eq!(resolve_runtime_app_version(None), APP_VERSION);
    }
}
