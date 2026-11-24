//! Host commands for pre-flight checkpoint rollback safety verification and
//! session rate-limit auto-resume recovery controls.

use agents::rate_limit_recovery::{RateLimitRecoveryError, UsageLimitRecovery};
use application::ApplicationError;
use conversations::{CheckpointRollbackSafety, RollbackSafetyError};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    domains::{ServerApplicationDomains, internal_error, parse, serialize},
    host::events::HostEventBus,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckRollbackSafetyArgs {
    #[serde(alias = "conversation_id", alias = "sessionId", alias = "session_id")]
    conversation_id: Uuid,
    #[serde(default)]
    ordinal: Option<i64>,
    #[serde(default, alias = "checkpoint_id")]
    checkpoint_id: Option<String>,
    #[serde(default, alias = "restore_files")]
    restore_files: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitUpdateAutoResumeArgs {
    #[serde(alias = "conversation_id", alias = "sessionId", alias = "session_id")]
    conversation_id: Uuid,
    #[serde(alias = "auto_resume")]
    auto_resume: bool,
    #[serde(default, alias = "continuation_prompt")]
    continuation_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitCancelWaitArgs {
    #[serde(alias = "conversation_id", alias = "sessionId", alias = "session_id")]
    conversation_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RateLimitPatchDecision {
    RateLimited,
    Cleared,
}

/// Inspects a `SessionInfoUpdated` JSON patch's `rateLimits` object using the same
/// detection criteria as `crates/conversations/src/projection/fold.rs`.
///
/// Returns `Some((RateLimited, rl))` when the session is actively rate-limited,
/// `Some((Cleared, rl))` when `rateLimits` explicitly clears the limit (e.g.
/// `isRateLimited == false` or `status == "allowed"`), or `None` when the patch has
/// no `rateLimits` object or represents ordinary non-limited telemetry.
pub(crate) fn classify_rate_limit_patch(patch: &Value) -> Option<(RateLimitPatchDecision, &Value)> {
    let rl_val = patch.get("rateLimits")?;
    let rl = rl_val.as_object()?;

    if let Some(explicit) = rl
        .get("isRateLimited")
        .or_else(|| rl.get("is_rate_limited"))
        .and_then(Value::as_bool)
    {
        return Some((
            if explicit {
                RateLimitPatchDecision::RateLimited
            } else {
                RateLimitPatchDecision::Cleared
            },
            rl_val,
        ));
    }

    if let Some(status) = rl
        .get("status")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase())
    {
        if matches!(
            status.as_str(),
            "rejected" | "rate_limited" | "exceeded" | "limited"
        ) {
            return Some((RateLimitPatchDecision::RateLimited, rl_val));
        }
        if matches!(status.as_str(), "allowed" | "ok" | "available" | "normal") {
            return Some((RateLimitPatchDecision::Cleared, rl_val));
        }
    }

    let win = rl.get("primary").and_then(Value::as_object).unwrap_or(rl);
    let secondary = rl.get("secondary").and_then(Value::as_object);
    let reset = rl
        .get("resetAt")
        .or_else(|| rl.get("resetsAt"))
        .or_else(|| rl.get("reset_at"))
        .or_else(|| rl.get("resets_at"))
        .or_else(|| win.get("resetsAt"))
        .or_else(|| win.get("resetAt"))
        .or_else(|| win.get("reset_at"))
        .or_else(|| {
            secondary.and_then(|s| {
                s.get("resetsAt")
                    .or_else(|| s.get("resetAt"))
                    .or_else(|| s.get("reset_at"))
            })
        });
    let zero_quota = rl.get("requestsRemaining").and_then(Value::as_i64) == Some(0)
        || rl.get("tokensRemaining").and_then(Value::as_i64) == Some(0);
    let full_util = rl
        .get("utilization")
        .and_then(Value::as_f64)
        .is_some_and(|u| (0.9999..=1.05).contains(&u) || u >= 100.0)
        || win
            .get("usedPercent")
            .and_then(Value::as_f64)
            .is_some_and(|u| u >= 100.0)
        || secondary
            .and_then(|s| s.get("usedPercent"))
            .and_then(Value::as_f64)
            .is_some_and(|u| u >= 100.0);

    if (zero_quota || full_util) && reset.is_some() {
        return Some((RateLimitPatchDecision::RateLimited, rl_val));
    }

    None
}

/// Applies one `AgentEvent::SessionInfoUpdated` patch to `UsageLimitRecovery` and
/// emits the matching `conversation-rate-limit:{conversation_id}` host event.
pub(crate) fn process_rate_limit_patch(
    recovery: &UsageLimitRecovery,
    events: &HostEventBus,
    conversation_id: Uuid,
    engine_id: &str,
    patch: &Value,
) -> bool {
    let Some((decision, rate_limits)) = classify_rate_limit_patch(patch) else {
        return false;
    };
    match decision {
        RateLimitPatchDecision::RateLimited => {
            match recovery.on_rate_limited(conversation_id, engine_id, rate_limits) {
                Ok(state) => {
                    events.emit(
                        format!("conversation-rate-limit:{conversation_id}"),
                        json!({
                            "conversationId": conversation_id,
                            "kind": "rate_limited",
                            "rateLimit": state,
                        }),
                    );
                    true
                }
                Err(error) => {
                    tracing::debug!(
                        %conversation_id,
                        engine_id,
                        %error,
                        "rate-limit patch did not include a parseable reset timestamp"
                    );
                    false
                }
            }
        }
        RateLimitPatchDecision::Cleared => {
            if recovery.cancel_wait(conversation_id) {
                events.emit(
                    format!("conversation-rate-limit:{conversation_id}"),
                    json!({
                        "conversationId": conversation_id,
                        "kind": "rate_limit_cancelled",
                    }),
                );
                true
            } else {
                false
            }
        }
    }
}

fn unwrap_request(args: Value) -> Value {
    if let Some(inner) = args.get("request")
        && inner.is_object()
    {
        return inner.clone();
    }
    args
}

pub(crate) async fn check_rollback_safety(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: CheckRollbackSafetyArgs = parse(unwrap_request(args))?;
    let checkpoint_key = input
        .checkpoint_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| input.ordinal.map(|ord| ord.to_string()))
        .unwrap_or_default();

    let report = CheckpointRollbackSafety::verify_safety(
        domains.writer_pool(),
        input.conversation_id,
        &checkpoint_key,
    )
    .await
    .map_err(|err| match err {
        RollbackSafetyError::ConversationNotFound(_)
        | RollbackSafetyError::CheckpointNotFound { .. } => {
            ApplicationError::not_found(err.to_string())
        }
        RollbackSafetyError::WorkspaceLocked { .. } => ApplicationError::conflict(err.to_string()),
        RollbackSafetyError::Database(_) => internal_error(err),
    })?;

    if report.is_safe_or_degraded()
        && input.restore_files.unwrap_or(false)
        && let Some(ordinal) = input.ordinal.or_else(|| checkpoint_key.parse::<i64>().ok())
    {
        let service = conversations::ConversationSessionService::new(domains.conversations.clone());
        if let Err(preflight_err) = service
            .preflight_rewind(input.conversation_id, ordinal, true)
            .await
        {
            return match preflight_err {
                conversations::ConversationServiceError::NotFound(msg) => {
                    Err(ApplicationError::not_found(msg))
                }
                conversations::ConversationServiceError::Conflict(reason)
                | conversations::ConversationServiceError::BadRequest(reason) => {
                    serialize(conversations::RollbackSafetyReport::Unsafe { reason })
                }
                other => Err(internal_error(other)),
            };
        }
    }

    serialize(report)
}

pub(crate) async fn update_rate_limit_auto_resume(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: RateLimitUpdateAutoResumeArgs = parse(unwrap_request(args))?;
    match domains.rate_limit_recovery.set_auto_resume(
        input.conversation_id,
        input.auto_resume,
        input.continuation_prompt,
    ) {
        Ok(state) => {
            domains.events.emit(
                format!("conversation-rate-limit:{}", input.conversation_id),
                json!({
                    "conversationId": input.conversation_id,
                    "kind": "rate_limit_updated",
                    "rateLimit": state,
                }),
            );
            Ok(Value::Null)
        }
        Err(RateLimitRecoveryError::SessionNotRateLimited(_)) => Ok(Value::Null),
        Err(other) => Err(ApplicationError::bad_request(other.to_string())),
    }
}

pub(crate) async fn cancel_rate_limit_wait(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: RateLimitCancelWaitArgs = parse(unwrap_request(args))?;
    if domains
        .rate_limit_recovery
        .cancel_wait(input.conversation_id)
    {
        domains.events.emit(
            format!("conversation-rate-limit:{}", input.conversation_id),
            json!({
                "conversationId": input.conversation_id,
                "kind": "rate_limit_cancelled",
            }),
        );
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};

    use super::*;

    #[tokio::test]
    async fn rate_limited_codex_and_claude_patches_schedule_wait_and_emit_event() {
        let recovery = UsageLimitRecovery::new();
        let events = HostEventBus::new();
        let mut rx = events.subscribe();

        // Codex `rateLimits.primary.resetsAt` with 100% utilization
        let codex_conversation_id = Uuid::new_v4();
        let codex_reset_secs = (Utc::now() + Duration::hours(1)).timestamp();
        let codex_patch = json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 100.0,
                    "resetsAt": codex_reset_secs,
                }
            }
        });
        assert!(process_rate_limit_patch(
            &recovery,
            &events,
            codex_conversation_id,
            "codex",
            &codex_patch,
        ));
        let codex_state = recovery
            .get_state(codex_conversation_id)
            .expect("codex wait state should be recorded");
        assert_eq!(codex_state.engine_id, "codex");
        assert_eq!(codex_state.reset_at.timestamp(), codex_reset_secs);
        assert!(codex_state.auto_resume);

        let codex_event = rx.try_recv().expect("codex rate_limited event emitted");
        assert_eq!(
            codex_event.channel,
            format!("conversation-rate-limit:{codex_conversation_id}")
        );
        assert_eq!(codex_event.payload["conversationId"], codex_conversation_id.to_string());
        assert_eq!(codex_event.payload["kind"], "rate_limited");
        assert_eq!(codex_event.payload["rateLimit"]["engineId"], "codex");

        // Claude `rateLimits.resetAt` with explicit `isRateLimited: true`
        let claude_conversation_id = Uuid::new_v4();
        let claude_reset_at = Utc::now() + Duration::hours(2);
        let claude_patch = json!({
            "rateLimits": {
                "isRateLimited": true,
                "resetAt": claude_reset_at.to_rfc3339(),
            }
        });
        assert!(process_rate_limit_patch(
            &recovery,
            &events,
            claude_conversation_id,
            "claude_code",
            &claude_patch,
        ));
        let claude_state = recovery
            .get_state(claude_conversation_id)
            .expect("claude wait state should be recorded");
        assert_eq!(claude_state.engine_id, "claude_code");
        assert_eq!(claude_state.reset_at.timestamp(), claude_reset_at.timestamp());

        let claude_event = rx.try_recv().expect("claude rate_limited event emitted");
        assert_eq!(
            claude_event.channel,
            format!("conversation-rate-limit:{claude_conversation_id}")
        );
        assert_eq!(
            claude_event.payload["conversationId"],
            claude_conversation_id.to_string()
        );
        assert_eq!(claude_event.payload["kind"], "rate_limited");
        assert_eq!(claude_event.payload["rateLimit"]["engineId"], "claude_code");

        // Clean up background sleep timers
        recovery.cancel_wait(codex_conversation_id);
        recovery.cancel_wait(claude_conversation_id);
    }

    #[tokio::test]
    async fn cleared_rate_limit_patch_cancels_wait_and_emits_cancelled() {
        let recovery = UsageLimitRecovery::new();
        let events = HostEventBus::new();
        let mut rx = events.subscribe();

        let conversation_id = Uuid::new_v4();
        let reset_at = (Utc::now() + Duration::hours(1)).to_rfc3339();
        let limited_patch = json!({
            "rateLimits": {
                "status": "rejected",
                "resetAt": reset_at,
            }
        });
        assert!(process_rate_limit_patch(
            &recovery,
            &events,
            conversation_id,
            "claude_code",
            &limited_patch,
        ));
        let _ = rx.try_recv().expect("initial rate_limited event");
        assert!(recovery.get_state(conversation_id).is_some());

        // Clearing via `isRateLimited: false` cancels the wait and emits `rate_limit_cancelled`
        let cleared_patch = json!({
            "rateLimits": {
                "isRateLimited": false,
            }
        });
        assert!(process_rate_limit_patch(
            &recovery,
            &events,
            conversation_id,
            "claude_code",
            &cleared_patch,
        ));
        assert!(recovery.get_state(conversation_id).is_none());

        let cancel_event = rx.try_recv().expect("rate_limit_cancelled event emitted");
        assert_eq!(
            cancel_event.channel,
            format!("conversation-rate-limit:{conversation_id}")
        );
        assert_eq!(cancel_event.payload["conversationId"], conversation_id.to_string());
        assert_eq!(cancel_event.payload["kind"], "rate_limit_cancelled");

        // A redundant clear when no wait is active should not emit another event
        let allowed_patch = json!({
            "rateLimits": {
                "status": "allowed",
            }
        });
        assert!(!process_rate_limit_patch(
            &recovery,
            &events,
            conversation_id,
            "claude_code",
            &allowed_patch,
        ));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn non_rate_limited_patches_do_nothing() {
        let recovery = UsageLimitRecovery::new();
        let events = HostEventBus::new();
        let mut rx = events.subscribe();

        let conversation_id = Uuid::new_v4();

        // Unrelated SessionInfoUpdated patch
        let title_patch = json!({ "title": "Fix rewind wiring" });
        assert!(!process_rate_limit_patch(
            &recovery,
            &events,
            conversation_id,
            "codex",
            &title_patch,
        ));

        // Normal non-exhausted rate-limit telemetry
        let normal_telemetry = json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 42.0,
                    "resetsAt": (Utc::now() + Duration::hours(1)).timestamp(),
                },
                "requestsRemaining": 50,
            }
        });
        assert!(!process_rate_limit_patch(
            &recovery,
            &events,
            conversation_id,
            "codex",
            &normal_telemetry,
        ));

        assert!(recovery.get_state(conversation_id).is_none());
        assert!(rx.try_recv().is_err());
    }
}
