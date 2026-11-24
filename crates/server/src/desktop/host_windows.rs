pub fn host_window_label(profile_id: &str) -> String {
    let safe: String = profile_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    format!("host-{safe}")
}

pub fn host_settings_window_label(profile_id: &str) -> String {
    format!("settings-{}", host_window_label(profile_id))
}

pub fn is_host_window(label: &str) -> bool {
    label.starts_with("host-") && label.len() > "host-".len()
}

pub fn is_host_settings_window(label: &str) -> bool {
    label.strip_prefix("settings-").is_some_and(is_host_window)
}

pub fn host_app_window_label(window_label: &str) -> Option<&str> {
    if is_host_window(window_label) {
        return Some(window_label);
    }
    is_host_settings_window(window_label)
        .then(|| window_label.strip_prefix("settings-"))
        .flatten()
}

pub fn host_settings_window_for_app(host_label: &str) -> Option<String> {
    let profile_id = host_label
        .strip_prefix("host-")
        .filter(|_| is_host_window(host_label))?;
    Some(host_settings_window_label(profile_id))
}

pub fn host_family_event_labels(window_label: &str) -> Vec<String> {
    let Some(host_label) = host_app_window_label(window_label) else {
        return Vec::new();
    };
    let mut labels = vec![host_label.to_string()];
    if let Some(settings) = host_settings_window_for_app(host_label) {
        labels.push(settings);
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_window_labels_are_stable_and_safe() {
        assert_eq!(
            host_window_label("550e8400-e29b-41d4-a716-446655440000"),
            "host-550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(host_window_label("a/b c"), "host-a-b-c");
        assert!(is_host_window("host-abc"));
        assert!(!is_host_window("main"));
        assert!(!is_host_window("settings"));
        assert!(!is_host_window("host-"));
        assert!(!is_host_window("settings-host-abc"));
        assert!(!is_host_window("app-local-1"));
    }

    #[test]
    fn settings_opened_from_a_host_window_stays_on_that_host() {
        assert_eq!(host_settings_window_label("abc"), "settings-host-abc");
        assert!(is_host_settings_window("settings-host-abc"));
        assert!(!is_host_settings_window("settings"));
        assert_eq!(host_app_window_label("host-abc"), Some("host-abc"));
        assert_eq!(host_app_window_label("settings-host-abc"), Some("host-abc"));
        assert_eq!(host_app_window_label("settings"), None);
        assert_eq!(host_app_window_label("main"), None);
        assert_eq!(
            host_settings_window_for_app("host-abc").as_deref(),
            Some("settings-host-abc")
        );
    }

    #[test]
    fn host_family_events_stay_on_that_host() {
        assert_eq!(
            host_family_event_labels("host-abc"),
            vec!["host-abc".to_string(), "settings-host-abc".to_string()]
        );
        assert_eq!(
            host_family_event_labels("settings-host-abc"),
            vec!["host-abc".to_string(), "settings-host-abc".to_string()]
        );
        assert!(host_family_event_labels("main").is_empty());
    }
}
