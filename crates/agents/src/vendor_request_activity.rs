//! Versioned adapter contracts; ordinary prose and stderr are never inputs.
use serde_json::Value;

use crate::{
    AgentKind,
    request_status::{RequestActivity, RequestPhase, RequestRetry},
};

/// Universal structured `_session/retrying` ACP extension (originated by Mistral Vibe
/// and supported across ACP registry adapters). Requires either a recognized `category`
/// or explicit structured retry fields so arbitrary notifications never trigger retry UI.
pub(crate) fn registry_extension(
    _agent_id: &crate::AgentId,
    method: &str,
    params: &Value,
) -> Option<RequestActivity> {
    if method != "_session/retrying" {
        return None;
    }
    let obj = params.as_object()?;
    let category = obj.get("category").and_then(Value::as_str);
    let valid_category = category.is_some_and(|cat| {
        matches!(
            cat,
            "rate_limited" | "server_error" | "timed_out" | "connection" | "unknown"
        )
    });
    if category.is_some() && !valid_category {
        return None;
    }
    let attempt_val = obj
        .get("attempt")
        .or_else(|| obj.get("retryAttempt"))
        .or_else(|| obj.get("retry_attempt"));
    let max_val = obj
        .get("max_attempts")
        .or_else(|| obj.get("maxAttempts"))
        .or_else(|| obj.get("max_retries"))
        .or_else(|| obj.get("maxRetries"));
    let delay_val = obj
        .get("delay_ms")
        .or_else(|| obj.get("delayMs"))
        .or_else(|| obj.get("retry_delay_ms"))
        .or_else(|| obj.get("retryDelayMs"));
    if !valid_category && attempt_val.is_none() && max_val.is_none() && delay_val.is_none() {
        return None;
    }
    let reason = obj
        .get("detail")
        .or_else(|| obj.get("reason"))
        .or_else(|| obj.get("message"))
        .or_else(|| obj.get("error"))
        .and_then(Value::as_str);
    let code = obj
        .get("code")
        .or_else(|| obj.get("error_status"))
        .or_else(|| obj.get("errorStatus"))
        .or_else(|| obj.get("status"));
    Some(retrying_with_text_hints(
        attempt_val,
        max_val,
        delay_val,
        reason,
        code,
    ))
}

/// Pi ACP emits exact untagged (`message_id: None`) lifecycle lines on
/// `agent_message_chunk` such as `Retrying...` or
/// `Retrying (attempt 2/5, waiting 3s)...`. Match only the full trimmed frame
/// when `message_id` is absent so ordinary assistant prose is never intercepted.
pub(crate) fn pi_lifecycle_retry(
    agent_kind: Option<AgentKind>,
    chunk: &agent_client_protocol::schema::v1::ContentChunk,
) -> Option<RequestActivity> {
    if agent_kind != Some(AgentKind::Pi) || chunk.message_id.is_some() {
        return None;
    }
    let agent_client_protocol::schema::v1::ContentBlock::Text(text) = &chunk.content else {
        return None;
    };
    let trimmed = text.text.trim();
    if trimmed != "Retrying..." && !(trimmed.starts_with("Retrying (") && trimmed.ends_with(")..."))
    {
        return None;
    }
    let (attempt, max_attempts, delay_ms) = parse_retry_hints_from_text(trimmed);
    Some(RequestActivity {
        phase: RequestPhase::Retrying,
        retry: Some(RequestRetry {
            attempt,
            max_attempts,
            delay_ms,
            reason: None,
            code: None,
        }),
    })
}

/// Extracts optional `(attempt, max_attempts, delay_ms)` hints from structured
/// retry status strings (e.g. `Reconnecting... 2/5`, `attempt 2/5, waiting 3s`,
/// `429 rate limited, retrying in 2s`). Only matches `m/n` when retry/reconnect
/// context is present so HTTP versions or dates are never misparsed.
pub(crate) fn parse_retry_hints_from_text(text: &str) -> (Option<u32>, Option<u32>, Option<u64>) {
    let lower = text.to_ascii_lowercase();
    let has_retry_context = lower.contains("retry")
        || lower.contains("reconnect")
        || lower.contains("attempt")
        || text.contains("重试")
        || text.contains("重连");

    let (attempt, max_attempts) = if has_retry_context {
        extract_ratio_pair(text)
    } else {
        (None, None)
    };
    let delay_ms = extract_delay_ms(&lower);
    (attempt, max_attempts, delay_ms)
}

fn extract_ratio_pair(text: &str) -> (Option<u32>, Option<u32>) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' {
            // Walk backward over optional spaces then digits
            let mut left_end = i;
            while left_end > 0 && bytes[left_end - 1].is_ascii_whitespace() {
                left_end -= 1;
            }
            let mut left_start = left_end;
            while left_start > 0 && bytes[left_start - 1].is_ascii_digit() {
                left_start -= 1;
            }
            // Reject HTTP/1.1 or paths like foo/12
            let left_ok = left_start < left_end
                && (left_start == 0
                    || !(bytes[left_start - 1].is_ascii_alphanumeric()
                        || bytes[left_start - 1] == b'.'));

            // Walk forward over optional spaces then digits
            let mut right_start = i + 1;
            while right_start < bytes.len() && bytes[right_start].is_ascii_whitespace() {
                right_start += 1;
            }
            let mut right_end = right_start;
            while right_end < bytes.len() && bytes[right_end].is_ascii_digit() {
                right_end += 1;
            }
            let right_ok = right_start < right_end
                && (right_end == bytes.len()
                    || !(bytes[right_end].is_ascii_alphanumeric() || bytes[right_end] == b'.'));

            if left_ok
                && right_ok
                && let (Ok(attempt), Ok(max_attempts)) = (
                    text[left_start..left_end].parse::<u32>(),
                    text[right_start..right_end].parse::<u32>(),
                )
                && attempt > 0
                && max_attempts >= attempt
                && max_attempts <= 100
            {
                return (Some(attempt), Some(max_attempts));
            }
        }
        i += 1;
    }
    (None, None)
}

fn extract_delay_ms(lower: &str) -> Option<u64> {
    for keyword in ["waiting ", "in ", "after "] {
        let mut search_from = 0;
        while let Some(rel) = lower[search_from..].find(keyword) {
            let start = search_from + rel + keyword.len();
            let rest = lower[start..].trim_start();
            let num_end = rest
                .find(|c: char| !c.is_ascii_digit() && c != '.')
                .unwrap_or(rest.len());
            if num_end > 0 {
                let num_str = &rest[..num_end];
                let unit = rest[num_end..].trim_start();
                if let Ok(val) = num_str.parse::<f64>()
                    && val.is_finite()
                    && val > 0.0
                {
                    if unit.starts_with("ms") {
                        return Some(val.round() as u64);
                    }
                    if unit.starts_with('s')
                        && unit
                            .chars()
                            .nth(1)
                            .is_none_or(|c| !c.is_ascii_alphabetic() || unit.starts_with("sec"))
                    {
                        return Some((val * 1000.0).round() as u64);
                    }
                }
            }
            search_from = start;
        }
    }
    None
}

fn retrying_with_text_hints(
    attempt: Option<&Value>,
    max: Option<&Value>,
    delay: Option<&Value>,
    reason: Option<&str>,
    code: Option<&Value>,
) -> RequestActivity {
    let mut activity = retrying(attempt, max, delay, reason, code);
    if let (Some(retry), Some(text)) = (activity.retry.as_mut(), reason) {
        let (hint_attempt, hint_max, hint_delay) = parse_retry_hints_from_text(text);
        if retry.attempt.is_none() {
            retry.attempt = hint_attempt;
        }
        if retry.max_attempts.is_none() {
            retry.max_attempts = hint_max;
        }
        if retry.delay_ms.is_none() {
            retry.delay_ms = hint_delay;
        }
    }
    activity
}

fn retrying(
    attempt: Option<&Value>,
    max: Option<&Value>,
    delay: Option<&Value>,
    reason: Option<&str>,
    code: Option<&Value>,
) -> RequestActivity {
    RequestActivity {
        phase: RequestPhase::Retrying,
        retry: Some(RequestRetry {
            attempt: attempt
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok()),
            max_attempts: max
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok()),
            delay_ms: delay.and_then(Value::as_u64),
            reason: reason.map(|text| {
                crate::conversation::cap_preview_bytes(crate::stderr_tail::sanitize_diagnostic(
                    text,
                ))
            }),
            code: code.filter(|v| v.is_number() || v.is_string()).map(|v| {
                let text = v
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string());
                crate::conversation::cap_preview_bytes(crate::stderr_tail::sanitize_diagnostic(
                    &text,
                ))
            }),
        }),
    }
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::{ContentBlock, ContentChunk, TextContent};
    use serde_json::json;

    use super::*;

    #[test]
    fn session_retrying_extension_accepts_structured_payloads_across_acp_agents() {
        let params = json!({"sessionId":"vibe-session","category":"rate_limited","detail":"retrying after HTTP 429"});
        let vibe_id = crate::AgentId::parse("mistral-vibe").unwrap();
        let retry = registry_extension(&vibe_id, "_session/retrying", &params)
            .unwrap()
            .retry
            .unwrap();
        assert_eq!(
            (retry.attempt, retry.max_attempts, retry.delay_ms),
            (None, None, None)
        );

        let generic_params = json!({
            "sessionId": "s-1",
            "category": "connection",
            "attempt": 2,
            "maxAttempts": 5,
            "delayMs": 2500,
            "detail": "upstream timeout",
            "code": 503
        });
        let generic_id = crate::AgentId::parse("user-agent").unwrap();
        let generic_retry = registry_extension(&generic_id, "_session/retrying", &generic_params)
            .unwrap()
            .retry
            .unwrap();
        assert_eq!(
            (
                generic_retry.attempt,
                generic_retry.max_attempts,
                generic_retry.delay_ms,
                generic_retry.code.as_deref(),
            ),
            (Some(2), Some(5), Some(2500), Some("503"))
        );

        assert!(
            registry_extension(
                &generic_id,
                "_session/retrying",
                &json!({"category": "bogus"})
            )
            .is_none()
        );
        assert!(registry_extension(&generic_id, "_session/retrying", &json!({})).is_none());
    }

    #[test]
    fn parse_retry_hints_extracts_reconnecting_progress_and_delay() {
        assert_eq!(
            parse_retry_hints_from_text("Reconnecting... 2/5 (retrying in 3s)"),
            (Some(2), Some(5), Some(3000))
        );
        assert_eq!(
            parse_retry_hints_from_text("HTTP/1.1 503 Service Unavailable"),
            (None, None, None)
        );
    }

    #[test]
    fn ordinary_pi_text_never_becomes_runtime_activity() {
        for text in [
            "Retry finished, resuming.",
            "I am Retrying (attempt 2/5, waiting 3s)... in prose.",
        ] {
            let chunk = ContentChunk::new(ContentBlock::Text(TextContent::new(text)));
            assert!(pi_lifecycle_retry(Some(AgentKind::Pi), &chunk).is_none());
        }
    }

    #[test]
    fn pi_untagged_lifecycle_retry_chunk_maps_to_retrying_activity() {
        let untagged = ContentChunk::new(ContentBlock::Text(TextContent::new(
            "Retrying (attempt 2/5, waiting 3s)...",
        )));
        let retry = pi_lifecycle_retry(Some(AgentKind::Pi), &untagged)
            .unwrap()
            .retry
            .unwrap();
        assert_eq!(
            (retry.attempt, retry.max_attempts, retry.delay_ms),
            (Some(2), Some(5), Some(3000))
        );

        let tagged = untagged.clone().message_id("msg-1");
        assert!(pi_lifecycle_retry(Some(AgentKind::Pi), &tagged).is_none());
        assert!(pi_lifecycle_retry(Some(AgentKind::Codex), &untagged).is_none());
    }
}
