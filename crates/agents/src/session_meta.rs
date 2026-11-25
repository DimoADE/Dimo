//! Session-request `_meta` that rides on ACP `session/fork` RPCs.

use serde_json::{Map, Value};

use crate::fork::ForkPoint;

/// Build optional ACP session-request `_meta` carrying a [`ForkPoint`].
pub(crate) fn session_request_meta(fork_point: Option<&ForkPoint>) -> Option<Map<String, Value>> {
    let meta = fork_point
        .and_then(|point| point.to_meta().as_object().cloned())
        .unwrap_or_default();
    (!meta.is_empty()).then_some(meta)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn session_request_meta_encodes_fork_point_when_present() {
        assert!(session_request_meta(None).is_none());

        let point = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: None,
            message_occurrence: None,
        };
        let meta = session_request_meta(Some(&point)).expect("fork meta");
        assert_eq!(
            Value::Object(meta),
            json!({
                "jetbrains": {"air": {"fork": {"version": 1, "messageId": "msg_01"}}},
            })
        );
    }
}
