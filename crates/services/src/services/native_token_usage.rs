//! Usage-only readers for transcripts the ACP snapshot did not break down.
//!
//! These walk the same files Codeg's token panel parses, but they keep one
//! session row (ADR-0082). Context occupancy is not a token total. Qoder and
//! Codex report `input` inclusive of cache, so the cached part is split out
//! before the counters are summed.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use super::{ProjectUsageTokenCounts, VendorLogUsage, add_optional_i64};

pub(super) fn parse_acp_transcript(path: &Path) -> Result<Option<VendorLogUsage>, String> {
    let lines = read_json_lines(path)?;
    let mut session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mut model = String::new();
    let mut usage = ProjectUsageTokenCounts::default();
    let mut turns = 0_i64;
    let mut saw_turn_end = false;
    let mut first_timestamp = 0_i64;

    for value in &lines {
        if value.get("kind").and_then(Value::as_str) == Some("header") {
            if let Some(id) = value.get("session_id").and_then(Value::as_str)
                && !id.is_empty()
            {
                session_id = id.to_string();
            }
            continue;
        }
        let kind = value.get("k").and_then(Value::as_str).unwrap_or("");
        if first_timestamp == 0 {
            first_timestamp = value.get("t").and_then(Value::as_i64).unwrap_or(0);
        }
        let payload = value.get("p").cloned().unwrap_or(Value::Null);
        if kind == "turn_end" {
            saw_turn_end = true;
            turns += 1;
            remember_model(&mut model, payload.get("model").and_then(Value::as_str));
            if let Some(parsed) = acp_token_usage(payload.get("usage")) {
                add_counts(&mut usage, &parsed);
            }
        }
    }

    if !has_counts(&usage) {
        for value in &lines {
            if value.get("k").and_then(Value::as_str) != Some("update") {
                continue;
            }
            let payload = value.get("p");
            let update = payload.and_then(|value| value.get("update")).or(payload);
            let session_update = update
                .and_then(|value| value.get("sessionUpdate"))
                .and_then(Value::as_str);
            if session_update != Some("usage_update") && session_update != Some("turn_completed") {
                continue;
            }
            let usage_value = update.and_then(|value| value.get("usage")).or(update);
            if let Some(parsed) = acp_token_usage(usage_value) {
                add_counts(&mut usage, &parsed);
            }
            remember_model(
                &mut model,
                update
                    .and_then(|value| value.get("model"))
                    .and_then(Value::as_str),
            );
        }
    }

    if !has_counts(&usage) {
        return Ok(None);
    }

    Ok(Some(VendorLogUsage {
        external_session_id: session_id,
        timestamp: stamp(first_timestamp),
        model,
        tokens: finish_counts(usage),
        cost: None,
        summary: None,
        provider: "acp".to_string(),
        turns: saw_turn_end.then_some(turns),
    }))
}

pub(super) fn parse_kimi_wire(path: &Path) -> Result<Option<VendorLogUsage>, String> {
    let session_id = path
        .parent()
        .and_then(|agents| agents.parent())
        .and_then(|session| session.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mut model = String::new();
    let mut usage = ProjectUsageTokenCounts::default();
    let mut records = 0_i64;
    let mut first_timestamp = 0_i64;

    for value in read_json_lines(path)? {
        if first_timestamp == 0 {
            first_timestamp = kimi_timestamp(&value).unwrap_or(0);
        }
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type != "usage.record" {
            continue;
        }
        let Some(parsed) = kimi_usage(value.get("usage")) else {
            continue;
        };
        records += 1;
        add_counts(&mut usage, &parsed);
        remember_model(&mut model, value.get("model").and_then(Value::as_str));
        remember_model(
            &mut model,
            value
                .get("usage")
                .and_then(|usage| usage.get("model"))
                .and_then(Value::as_str),
        );
    }

    if !has_counts(&usage) {
        return Ok(None);
    }
    Ok(Some(VendorLogUsage {
        external_session_id: session_id,
        timestamp: stamp(first_timestamp),
        model,
        tokens: finish_counts(usage),
        cost: None,
        summary: None,
        provider: "kimi_code".to_string(),
        turns: Some(records),
    }))
}

pub(super) fn parse_qoder_session(path: &Path) -> Result<Option<VendorLogUsage>, String> {
    parse_assistant_jsonl(path, "qoder", true)
}

pub(super) fn parse_codebuddy_session(path: &Path) -> Result<Option<VendorLogUsage>, String> {
    let mut session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mut model = String::new();
    let mut usage = ProjectUsageTokenCounts::default();
    let mut turns = 0_i64;
    let mut first_timestamp = 0_i64;

    for value in read_json_lines(path)? {
        if first_timestamp == 0 {
            first_timestamp = value.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        }
        if let Some(id) = value.get("sessionId").and_then(Value::as_str)
            && !id.is_empty()
        {
            session_id = id.to_string();
        }
        remember_model(&mut model, value.get("model").and_then(Value::as_str));
        let Some(parsed) = codebuddy_usage(&value) else {
            continue;
        };
        turns += 1;
        add_counts(&mut usage, &parsed);
    }

    if !has_counts(&usage) {
        return Ok(None);
    }
    Ok(Some(VendorLogUsage {
        external_session_id: session_id,
        timestamp: stamp(first_timestamp),
        model,
        tokens: finish_counts(usage),
        cost: None,
        summary: None,
        provider: "codebuddy".to_string(),
        turns: Some(turns),
    }))
}

fn parse_assistant_jsonl(
    path: &Path,
    provider: &str,
    cache_is_inside_input: bool,
) -> Result<Option<VendorLogUsage>, String> {
    let mut session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mut model = String::new();
    let mut usage = ProjectUsageTokenCounts::default();
    let mut turns = 0_i64;
    let mut first_timestamp = 0_i64;

    for value in read_json_lines(path)? {
        if first_timestamp == 0
            && let Some(text) = value.get("timestamp").and_then(Value::as_str)
        {
            first_timestamp = chrono::DateTime::parse_from_rfc3339(text)
                .map(|value| value.timestamp_millis())
                .unwrap_or(0);
        }
        if let Some(id) = value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str)
            && !id.is_empty()
        {
            session_id = id.to_string();
        }
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        remember_model(&mut model, message.get("model").and_then(Value::as_str));
        let Some(parsed) = anthropic_usage(message.get("usage"), cache_is_inside_input) else {
            continue;
        };
        turns += 1;
        add_counts(&mut usage, &parsed);
    }

    if !has_counts(&usage) {
        return Ok(None);
    }
    Ok(Some(VendorLogUsage {
        external_session_id: session_id,
        timestamp: stamp(first_timestamp),
        model,
        tokens: finish_counts(usage),
        cost: None,
        summary: None,
        provider: provider.to_string(),
        turns: Some(turns),
    }))
}

fn read_json_lines(path: &Path) -> Result<Vec<Value>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let mut lines = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        if line.len() > 512_000 {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            lines.push(value);
        }
    }
    Ok(lines)
}

fn acp_token_usage(value: Option<&Value>) -> Option<ProjectUsageTokenCounts> {
    let value = value?;
    let number = |camel: &str, snake: &str| -> i64 {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_u64().map(|value| value as i64))
            })
            .unwrap_or(0)
    };
    let input = number("inputTokens", "input_tokens");
    let output = number("outputTokens", "output_tokens");
    let cache_write = number("cacheCreationInputTokens", "cache_creation_input_tokens");
    let cache_read = number("cacheReadInputTokens", "cache_read_input_tokens");
    if input == 0 && output == 0 && cache_write == 0 && cache_read == 0 {
        return None;
    }
    Some(counts(input, output, cache_write, cache_read))
}

fn anthropic_usage(
    value: Option<&Value>,
    cache_is_inside_input: bool,
) -> Option<ProjectUsageTokenCounts> {
    let value = value?;
    let number = |keys: &[&str]| -> i64 {
        keys.iter()
            .find_map(|key| value.get(*key))
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_u64().map(|value| value as i64))
            })
            .unwrap_or(0)
    };
    let mut input = number(&["input_tokens", "inputTokens"]);
    let output = number(&["output_tokens", "outputTokens"]);
    let cache_write = number(&["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    let cache_read = number(&["cache_read_input_tokens", "cacheReadInputTokens"]);
    if input == 0 && output == 0 && cache_write == 0 && cache_read == 0 {
        return None;
    }
    if cache_is_inside_input {
        input = input.saturating_sub(cache_read).saturating_sub(cache_write);
    }
    Some(counts(input, output, cache_write, cache_read))
}

fn codebuddy_usage(value: &Value) -> Option<ProjectUsageTokenCounts> {
    let raw = value.get("providerData")?.get("rawUsage")?;
    let prompt = raw
        .get("prompt_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion = raw
        .get("completion_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached = raw
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if prompt == 0 && completion == 0 && cached == 0 {
        return None;
    }
    Some(counts(prompt.saturating_sub(cached), completion, 0, cached))
}

fn kimi_usage(value: Option<&Value>) -> Option<ProjectUsageTokenCounts> {
    let value = value?;
    let number = |key: &str| -> i64 {
        value
            .get(key)
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_u64().map(|value| value as i64))
            })
            .unwrap_or(0)
    };
    let input = number("inputOther");
    let output = number("output");
    let cache_read = number("inputCacheRead");
    let cache_write = number("inputCacheCreation");
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(counts(input, output, cache_write, cache_read))
}

fn kimi_timestamp(value: &Value) -> Option<i64> {
    let raw = value.get("timestamp").or_else(|| value.get("ts"))?;
    if let Some(text) = raw.as_str() {
        return chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|value| value.timestamp_millis());
    }
    raw.as_i64()
}

fn counts(input: i64, output: i64, cache_write: i64, cache_read: i64) -> ProjectUsageTokenCounts {
    ProjectUsageTokenCounts {
        input_tokens: Some(input),
        output_tokens: Some(output),
        cache_write_tokens: Some(cache_write),
        cache_read_tokens: Some(cache_read),
        total_tokens: Some(input + output + cache_write + cache_read),
    }
}

fn add_counts(target: &mut ProjectUsageTokenCounts, extra: &ProjectUsageTokenCounts) {
    add_optional_i64(&mut target.input_tokens, extra.input_tokens);
    add_optional_i64(&mut target.output_tokens, extra.output_tokens);
    add_optional_i64(&mut target.cache_write_tokens, extra.cache_write_tokens);
    add_optional_i64(&mut target.cache_read_tokens, extra.cache_read_tokens);
}

fn finish_counts(mut usage: ProjectUsageTokenCounts) -> ProjectUsageTokenCounts {
    usage.total_tokens = Some(
        usage.input_tokens.unwrap_or(0)
            + usage.output_tokens.unwrap_or(0)
            + usage.cache_write_tokens.unwrap_or(0)
            + usage.cache_read_tokens.unwrap_or(0),
    );
    usage
}

fn has_counts(usage: &ProjectUsageTokenCounts) -> bool {
    usage.input_tokens.unwrap_or(0)
        + usage.output_tokens.unwrap_or(0)
        + usage.cache_write_tokens.unwrap_or(0)
        + usage.cache_read_tokens.unwrap_or(0)
        > 0
}

fn remember_model(model: &mut String, candidate: Option<&str>) {
    if !model.is_empty() {
        return;
    }
    let Some(candidate) = candidate.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    if agents::is_unresolved_model_alias(candidate) {
        return;
    }
    *model = candidate.to_string();
}

fn stamp(timestamp: i64) -> i64 {
    if timestamp > 0 {
        return timestamp;
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(super) fn parse_muse_session(path: &Path) -> Result<Option<VendorLogUsage>, String> {
    if path.file_name().and_then(|name| name.to_str()) != Some("session.jsonl") {
        return Ok(None);
    }
    let mut session_id = path
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mut model = String::new();
    let mut usage = ProjectUsageTokenCounts::default();
    let mut turns = 0_i64;
    let mut first_timestamp = 0_i64;
    let mut seen_run_ids = std::collections::HashSet::<String>::new();

    for value in read_json_lines(path)? {
        if let Some(ts_us) = value.get("recorded_at").and_then(Value::as_i64)
            && ts_us > 0
            && first_timestamp == 0
        {
            first_timestamp = ts_us / 1_000;
        }
        if let Some(id) = value
            .get("stream")
            .and_then(|s| s.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            session_id = id.to_string();
        }
        if value.get("record_type").and_then(Value::as_str) == Some("header")
            && let Some(id) = value
                .get("session_id")
                .or_else(|| value.get("payload").and_then(|p| p.get("session_id")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            session_id = id.to_string();
        }
        if value.get("record_type").and_then(Value::as_str) != Some("event") {
            continue;
        }
        if value.get("payload_type").and_then(Value::as_str) != Some("runtime.session") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if let Some(id) = payload
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            && session_id.is_empty()
        {
            session_id = id.to_string();
        }
        let Some(event) = payload.get("event") else {
            continue;
        };
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(kind, "model_completed" | "automated_review_completed") {
            continue;
        }
        let dedupe_key = payload
            .get("source_run_record_id")
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(key) = dedupe_key
            && !seen_run_ids.insert(key)
        {
            continue;
        }
        let model_id = event
            .get("model")
            .and_then(|m| {
                m.as_str()
                    .or_else(|| m.get("model_id").and_then(Value::as_str))
                    .or_else(|| m.get("modelId").and_then(Value::as_str))
            })
            .or_else(|| event.get("model_id").and_then(Value::as_str))
            .or_else(|| payload.get("model").and_then(Value::as_str));
        remember_model(&mut model, model_id);
        let Some(parsed) = muse_usage(event.get("usage").or_else(|| event.get("token_usage")))
        else {
            continue;
        };
        turns += 1;
        add_counts(&mut usage, &parsed);
    }

    if !has_counts(&usage) {
        return Ok(None);
    }
    Ok(Some(VendorLogUsage {
        external_session_id: session_id,
        timestamp: stamp(first_timestamp),
        model,
        tokens: finish_counts(usage),
        cost: None,
        summary: None,
        provider: "muse_code".to_string(),
        turns: Some(turns),
    }))
}

fn muse_usage(raw: Option<&Value>) -> Option<ProjectUsageTokenCounts> {
    let obj = raw?.as_object()?;
    let read_i64 = |keys: &[&str]| -> i64 {
        keys.iter()
            .find_map(|key| obj.get(*key).and_then(Value::as_i64))
            .unwrap_or(0)
            .max(0)
    };
    let raw_input = read_i64(&["input_tokens", "inputTokens", "prompt_tokens"]);
    let output = read_i64(&["output_tokens", "outputTokens", "completion_tokens"]);
    let raw_cache_read = read_i64(&[
        "cache_read_tokens",
        "cacheReadTokens",
        "cached_input_tokens",
        "cached_tokens",
        "cache_read_input_tokens",
    ]);
    let raw_cache_write = read_i64(&[
        "cache_write_tokens",
        "cacheWriteTokens",
        "cache_creation_input_tokens",
    ]);
    // Muse reports cache_read and cache_write as subsets of input_tokens; clamp defensively.
    let cache_read = raw_cache_read.min(raw_input);
    let cache_write = raw_cache_write.min(raw_input.saturating_sub(cache_read));
    let uncached_input = raw_input.saturating_sub(cache_read.saturating_add(cache_write));
    if uncached_input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(counts(uncached_input, output, cache_write, cache_read))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qoder_cache_is_split_out_of_input() {
        let usage = anthropic_usage(
            Some(&serde_json::json!({
                "input_tokens": 20513,
                "output_tokens": 100,
                "cache_read_input_tokens": 18871,
                "cache_creation_input_tokens": 0
            })),
            true,
        )
        .expect("usage");
        assert_eq!(usage.input_tokens, Some(1642));
        assert_eq!(usage.cache_read_tokens, Some(18871));
        assert_eq!(usage.total_tokens, Some(20613));
    }

    #[test]
    fn kimi_record_keeps_input_other_disjoint() {
        let usage = kimi_usage(Some(&serde_json::json!({
            "inputOther": 10,
            "output": 4,
            "inputCacheRead": 20,
            "inputCacheCreation": 1
        })))
        .expect("usage");
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.total_tokens, Some(35));
    }

    #[test]
    fn codebuddy_prompt_tokens_include_cache() {
        let usage = codebuddy_usage(&serde_json::json!({
            "providerData": {
                "rawUsage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 5,
                    "prompt_tokens_details": { "cached_tokens": 80 }
                }
            }
        }))
        .expect("usage");
        assert_eq!(usage.input_tokens, Some(20));
        assert_eq!(usage.cache_read_tokens, Some(80));
        assert_eq!(usage.total_tokens, Some(105));
    }

    #[test]
    fn muse_session_jsonl_dedupes_runs_and_splits_cache_from_input() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("muse-sess-42");
        std::fs::create_dir_all(&session_dir).unwrap();
        let file = session_dir.join("session.jsonl");
        let lines = [
            r#"{"schema_version":1,"id":"r1","recorded_at":1750000000123000,"record_type":"event","payload_type":"runtime.session","stream":{"kind":"session","id":"stream-sess-42"},"payload":{"source_run_record_id":"run-1","event":{"kind":"model_completed","model":{"model_id":"muse-2"},"usage":{"input_tokens":1000,"output_tokens":200,"cache_read_tokens":700,"cache_write_tokens":100}}}}"#,
            r#"{"schema_version":1,"id":"r2","recorded_at":1750000001000000,"record_type":"event","payload_type":"runtime.session","stream":{"kind":"session","id":"stream-sess-42"},"payload":{"source_run_record_id":"run-1","event":{"kind":"model_completed","model":"muse-2","usage":{"input_tokens":1000,"output_tokens":200,"cache_read_tokens":700,"cache_write_tokens":100}}}}"#,
            r#"{"schema_version":1,"id":"r3","recorded_at":1750000002000000,"record_type":"event","payload_type":"runtime.session","stream":{"kind":"session","id":"stream-sess-42"},"payload":{"event":{"kind":"automated_review_completed","model":"muse-2","usage":{"input_tokens":500,"output_tokens":50,"cached_tokens":100,"cache_write_tokens":0}}}}"#,
        ];
        std::fs::write(&file, lines.join("\n")).unwrap();
        let parsed = parse_muse_session(&file).unwrap().expect("parsed usage");
        assert_eq!(parsed.provider, "muse_code");
        assert_eq!(parsed.external_session_id, "stream-sess-42");
        assert_eq!(parsed.model, "muse-2");
        assert_eq!(parsed.timestamp, 1_750_000_000_123);
        assert_eq!(parsed.turns, Some(2));
        assert_eq!(parsed.tokens.input_tokens, Some(600));
        assert_eq!(parsed.tokens.output_tokens, Some(250));
        assert_eq!(parsed.tokens.cache_read_tokens, Some(800));
        assert_eq!(parsed.tokens.cache_write_tokens, Some(100));
        assert_eq!(parsed.tokens.total_tokens, Some(1750));
    }
}
