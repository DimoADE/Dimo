use std::path::{Component, Path, PathBuf};

use agent_client_protocol::schema::v1::{
    ToolCall, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use workspace_utils::{diff::create_unified_diff, process::new_hidden_tokio_command};

use super::*;

const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const JSON_PREVIEW_BUDGET_BYTES: usize =
    crate::conversation::MAX_TIMELINE_PREVIEW_BYTES.saturating_sub(512);

const PATH_KEYS: &[&str] = &[
    "file_path",
    "target_file",
    "targetFile",
    "path",
    "TargetFile",
    "filePath",
    "filepath",
    "abs_path",
    "absolute_path",
    "absolutePath",
    "AbsolutePath",
    "filename",
    "file",
    "uri",
];

const NON_EMPTY_DIFF_STR_KEYS: &[&str] = &["unified_diff", "diff", "patch"];

const STRUCTURED_TEXT_KEYS: &[&str] = &[
    "old_string",
    "old_str",
    "oldText",
    "old_text",
    "old",
    "new_string",
    "new_str",
    "newText",
    "new_text",
    "new",
    "replacement",
    "content",
    "contents",
    "new_content",
    "text",
    "TargetContent",
    "ReplacementContent",
    "CodeContent",
];

const STRUCTURED_COLLECTION_KEYS: &[&str] = &["edits", "changes", "ReplacementChunks"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::manager) enum FileSnapshot {
    Missing,
    Text(String),
    Skipped,
}

#[derive(Debug, Clone)]
struct PendingEditSnapshot {
    raw_path: String,
    canonical_key: PathBuf,
    disk_path: PathBuf,
    before: FileSnapshot,
    start_revision: u64,
    original_raw_input: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct LatestFileState {
    revision: u64,
    snapshot: FileSnapshot,
}

#[derive(Debug, Default)]
pub(in crate::manager) struct EditDiffTracker {
    active_prompt: Option<(AgentSessionId, AgentPromptId)>,
    pending_calls: HashMap<String, PendingEditSnapshot>,
    latest_files: HashMap<PathBuf, LatestFileState>,
    next_revision: u64,
}

impl EditDiffTracker {
    fn sync_prompt(&mut self, current: Option<(AgentSessionId, AgentPromptId)>) {
        if let Some(prompt) = current
            && self.active_prompt != Some(prompt)
        {
            self.active_prompt = Some(prompt);
            self.pending_calls.clear();
            self.latest_files.clear();
            self.next_revision = 0;
        }
    }
}

impl AcpClientBridge {
    pub(in crate::manager) async fn capture_edit_tool_start(
        &self,
        session_id: Option<AgentSessionId>,
        call_id: &str,
        tool_call: &ToolCall,
    ) -> Option<String> {
        if !matches!(
            tool_call.kind,
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move
        ) {
            return None;
        }
        if is_failed_status(&tool_call.status) {
            return None;
        }
        if has_structured_diff_or_content(tool_call.raw_input.as_ref(), &tool_call.content) {
            return None;
        }

        let raw_path = extract_tool_path(tool_call.raw_input.as_ref(), &tool_call.locations)?;
        let disk_path = resolve_disk_path(&self.working_dir, &raw_path);
        let canonical_key = resolve_canonical_key(&disk_path).await;
        let current_snapshot = read_file_snapshot(&disk_path).await;
        let current_prompt = *self.apply.active_prompt.lock().await;

        if matches!(tool_call.status, ToolCallStatus::Completed) {
            let prior = {
                let mut tracker = self.edit_diff.lock().await;
                tracker.sync_prompt(current_prompt);
                tracker.latest_files.get(&canonical_key).cloned()
            };
            let base = select_fallback_base(
                &current_snapshot,
                prior.as_ref(),
                &disk_path,
                &self.working_dir,
                session_id,
            )
            .await;
            {
                let mut tracker = self.edit_diff.lock().await;
                tracker.sync_prompt(current_prompt);
                tracker.next_revision += 1;
                let revision = tracker.next_revision;
                tracker.latest_files.insert(
                    canonical_key,
                    LatestFileState {
                        revision,
                        snapshot: current_snapshot.clone(),
                    },
                );
            }
            let base = base?;
            return build_enriched_input_preview(
                tool_call.raw_input.as_ref(),
                &raw_path,
                &base,
                &current_snapshot,
            );
        }

        let mut tracker = self.edit_diff.lock().await;
        tracker.sync_prompt(current_prompt);
        let start_revision = tracker.next_revision;
        tracker.pending_calls.insert(
            call_id.to_string(),
            PendingEditSnapshot {
                raw_path,
                canonical_key,
                disk_path,
                before: current_snapshot,
                start_revision,
                original_raw_input: tool_call.raw_input.clone(),
            },
        );
        None
    }

    pub(in crate::manager) async fn finish_edit_tool_update(
        &self,
        session_id: Option<AgentSessionId>,
        call_id: &str,
        update: &ToolCallUpdate,
    ) -> Option<String> {
        let content_blocks = update.fields.content.as_deref().unwrap_or_default();
        let has_structured =
            has_structured_diff_or_content(update.fields.raw_input.as_ref(), content_blocks);
        let current_prompt = *self.apply.active_prompt.lock().await;

        let Some(status) = update.fields.status.as_ref() else {
            if has_structured {
                let mut tracker = self.edit_diff.lock().await;
                tracker.sync_prompt(current_prompt);
                tracker.pending_calls.remove(call_id);
            }
            return None;
        };

        if matches!(status, ToolCallStatus::Pending | ToolCallStatus::InProgress) {
            if has_structured {
                let mut tracker = self.edit_diff.lock().await;
                tracker.sync_prompt(current_prompt);
                tracker.pending_calls.remove(call_id);
            }
            return None;
        }

        if !matches!(status, ToolCallStatus::Completed) {
            let mut tracker = self.edit_diff.lock().await;
            tracker.sync_prompt(current_prompt);
            tracker.pending_calls.remove(call_id);
            return None;
        }

        let pending = {
            let mut tracker = self.edit_diff.lock().await;
            tracker.sync_prompt(current_prompt);
            tracker.pending_calls.remove(call_id)
        }?;

        if has_structured {
            return None;
        }

        let after = read_file_snapshot(&pending.disk_path).await;
        let prior = {
            let tracker = self.edit_diff.lock().await;
            tracker.latest_files.get(&pending.canonical_key).cloned()
        };

        let base = if let Some(prior_state) = prior.as_ref()
            && prior_state.revision > pending.start_revision
        {
            Some(prior_state.snapshot.clone())
        } else if pending.before != after {
            Some(pending.before.clone())
        } else {
            select_fallback_base(
                &after,
                prior.as_ref(),
                &pending.disk_path,
                &self.working_dir,
                session_id,
            )
            .await
        };

        {
            let mut tracker = self.edit_diff.lock().await;
            tracker.sync_prompt(current_prompt);
            tracker.next_revision += 1;
            let revision = tracker.next_revision;
            tracker.latest_files.insert(
                pending.canonical_key,
                LatestFileState {
                    revision,
                    snapshot: after.clone(),
                },
            );
        }

        let base = base?;
        let raw_input_base = update
            .fields
            .raw_input
            .as_ref()
            .or(pending.original_raw_input.as_ref());
        build_enriched_input_preview(raw_input_base, &pending.raw_path, &base, &after)
    }
}

async fn select_fallback_base(
    after: &FileSnapshot,
    prior: Option<&LatestFileState>,
    disk_path: &Path,
    working_dir: &Path,
    session_id: Option<AgentSessionId>,
) -> Option<FileSnapshot> {
    if let Some(prior_state) = prior
        && &prior_state.snapshot != after
    {
        return Some(prior_state.snapshot.clone());
    }
    let session_id = session_id?;
    let checkpoint = read_checkpoint_snapshot(disk_path, working_dir, session_id).await?;
    (&checkpoint != after).then_some(checkpoint)
}

fn is_failed_status(status: &ToolCallStatus) -> bool {
    if matches!(
        status,
        ToolCallStatus::Pending | ToolCallStatus::InProgress | ToolCallStatus::Completed
    ) {
        return false;
    }
    true
}

pub(in crate::manager) fn has_structured_diff_or_content(
    raw_input: Option<&serde_json::Value>,
    content: &[ToolCallContent],
) -> bool {
    if content
        .iter()
        .any(|item| matches!(item, ToolCallContent::Diff(_)))
    {
        return true;
    }
    let Some(raw_input) = raw_input else {
        return false;
    };
    if let Some(raw_text) = raw_input.as_str() {
        return raw_text.contains("*** Begin Patch");
    }
    let Some(map) = raw_input.as_object() else {
        return false;
    };
    if NON_EMPTY_DIFF_STR_KEYS.iter().any(|key| {
        map.get(*key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    }) {
        return true;
    }
    if map
        .get("input")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|text| text.contains("*** Begin Patch"))
    {
        return true;
    }
    if STRUCTURED_TEXT_KEYS
        .iter()
        .any(|key| map.get(*key).is_some_and(serde_json::Value::is_string))
    {
        return true;
    }
    if STRUCTURED_COLLECTION_KEYS.iter().any(|key| {
        map.get(*key)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| !items.is_empty())
    }) {
        return true;
    }
    false
}

fn extract_tool_path(
    raw_input: Option<&serde_json::Value>,
    locations: &[ToolCallLocation],
) -> Option<String> {
    if let Some(map) = raw_input.and_then(serde_json::Value::as_object) {
        for key in PATH_KEYS {
            if let Some(raw) = map.get(*key).and_then(serde_json::Value::as_str)
                && let Some(cleaned) = normalize_extracted_path(raw)
            {
                return Some(cleaned);
            }
        }
    }
    locations
        .first()
        .and_then(|loc| normalize_extracted_path(&Path::new(&loc.path).to_string_lossy()))
}

fn normalize_extracted_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix("file://") {
        let candidate = if stripped.starts_with('/')
            && stripped.as_bytes().get(2) == Some(&b':')
            && stripped
                .as_bytes()
                .get(1)
                .is_some_and(u8::is_ascii_alphabetic)
        {
            &stripped[1..]
        } else {
            stripped
        };
        let candidate = candidate.trim();
        return (!candidate.is_empty()).then(|| candidate.to_string());
    }
    Some(trimmed.to_string())
}

fn resolve_disk_path(working_dir: &Path, raw_path: &str) -> PathBuf {
    let candidate = Path::new(raw_path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        working_dir.join(candidate)
    }
}

fn clean_lexical_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(comp);
                }
            }
            _ => out.push(comp),
        }
    }
    out
}

async fn resolve_canonical_key(disk_path: &Path) -> PathBuf {
    let cleaned = clean_lexical_path(disk_path);
    if let Ok(canonical) = tokio::fs::canonicalize(&cleaned).await {
        return canonical;
    }
    let mut ancestor = cleaned.as_path();
    let mut tail = Vec::new();
    while let Some(name) = ancestor.file_name() {
        tail.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        if let Ok(canonical_parent) = tokio::fs::canonicalize(parent).await {
            let mut result = canonical_parent;
            for part in tail.into_iter().rev() {
                result.push(part);
            }
            return result;
        }
        ancestor = parent;
    }
    cleaned
}

async fn read_file_snapshot(path: &Path) -> FileSnapshot {
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return FileSnapshot::Missing,
        Err(_) => return FileSnapshot::Skipped,
    };
    if !meta.is_file() || meta.len() > MAX_SNAPSHOT_BYTES as u64 {
        return FileSnapshot::Skipped;
    }
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return FileSnapshot::Missing,
        Err(_) => return FileSnapshot::Skipped,
    };
    snapshot_from_bytes(bytes)
}

fn snapshot_from_bytes(bytes: Vec<u8>) -> FileSnapshot {
    if bytes.len() > MAX_SNAPSHOT_BYTES || bytes.contains(&0) {
        return FileSnapshot::Skipped;
    }
    match String::from_utf8(bytes) {
        Ok(text) => FileSnapshot::Text(text),
        Err(_) => FileSnapshot::Skipped,
    }
}

async fn read_checkpoint_snapshot(
    disk_path: &Path,
    working_dir: &Path,
    session_id: AgentSessionId,
) -> Option<FileSnapshot> {
    use std::ffi::OsStr;

    let start_dir = disk_path
        .parent()
        .filter(|parent| parent.exists())
        .unwrap_or(working_dir);
    let repo_root_out = new_hidden_tokio_command(
        "git",
        [
            OsStr::new("-C"),
            start_dir.as_os_str(),
            OsStr::new("rev-parse"),
            OsStr::new("--show-toplevel"),
        ],
    )
    .output()
    .await
    .ok()?;
    if !repo_root_out.status.success() {
        return None;
    }
    let repo_root_raw = String::from_utf8(repo_root_out.stdout).ok()?;
    let repo_root = PathBuf::from(repo_root_raw.trim());
    let canonical_root = resolve_canonical_key(&repo_root).await;
    let canonical_file = resolve_canonical_key(disk_path).await;
    let rel_path = canonical_file.strip_prefix(&canonical_root).ok()?;
    let rel_unix = rel_path
        .components()
        .filter_map(|comp| match comp {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if rel_unix.is_empty() {
        return None;
    }

    let prefix = format!(
        "{}/",
        crate::checkpoint_ref::CheckpointRef::ref_name(session_id.0, 0)
            .rsplit_once('/')?
            .0
    );
    let refs_out = new_hidden_tokio_command(
        "git",
        [
            OsStr::new("-C"),
            repo_root.as_os_str(),
            OsStr::new("for-each-ref"),
            OsStr::new("--format=%(refname) %(objectname)"),
            OsStr::new(&prefix),
        ],
    )
    .output()
    .await
    .ok()?;
    if !refs_out.status.success() {
        return None;
    }
    let refs_text = String::from_utf8(refs_out.stdout).ok()?;
    let latest_commit = refs_text
        .lines()
        .filter_map(|line| {
            let (refname, oid) = line.split_once(' ')?;
            let ordinal = refname.rsplit('/').next()?.parse::<i64>().ok()?;
            Some((ordinal, oid.trim()))
        })
        .max_by_key(|(ordinal, _)| *ordinal)
        .map(|(_, oid)| oid.to_string())?;

    let spec = format!("{latest_commit}:{rel_unix}");
    let size_out = new_hidden_tokio_command(
        "git",
        [
            OsStr::new("-C"),
            repo_root.as_os_str(),
            OsStr::new("cat-file"),
            OsStr::new("-s"),
            OsStr::new(&spec),
        ],
    )
    .output()
    .await
    .ok()?;
    if !size_out.status.success() {
        return Some(FileSnapshot::Missing);
    }
    let size: usize = String::from_utf8_lossy(&size_out.stdout)
        .trim()
        .parse()
        .ok()?;
    if size > MAX_SNAPSHOT_BYTES {
        return Some(FileSnapshot::Skipped);
    }

    let blob_out = new_hidden_tokio_command(
        "git",
        [
            OsStr::new("-C"),
            repo_root.as_os_str(),
            OsStr::new("cat-file"),
            OsStr::new("blob"),
            OsStr::new(&spec),
        ],
    )
    .output()
    .await
    .ok()?;
    if !blob_out.status.success() {
        return Some(FileSnapshot::Skipped);
    }
    Some(snapshot_from_bytes(blob_out.stdout))
}

fn diff_display_path(raw_path: &str) -> String {
    let normalized = raw_path.replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./");
    if trimmed.is_empty() {
        raw_path.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(in crate::manager) fn build_unified_diff_from_snapshots(
    raw_path: &str,
    before: &FileSnapshot,
    after: &FileSnapshot,
) -> Option<String> {
    if before == after {
        return None;
    }
    let display_path = diff_display_path(raw_path);
    let diff = match (before, after) {
        (FileSnapshot::Skipped, _) | (_, FileSnapshot::Skipped) => return None,
        (FileSnapshot::Missing, FileSnapshot::Missing) => return None,
        (FileSnapshot::Missing, FileSnapshot::Text(new_text)) => {
            format_whole_file_diff(None, Some(&display_path), new_text, true)?
        }
        (FileSnapshot::Text(old_text), FileSnapshot::Missing) => {
            format_whole_file_diff(Some(&display_path), None, old_text, false)?
        }
        (FileSnapshot::Text(old_text), FileSnapshot::Text(new_text)) => {
            if old_text.is_empty() && !new_text.is_empty() {
                format_whole_file_diff(Some(&display_path), Some(&display_path), new_text, true)?
            } else if !old_text.is_empty() && new_text.is_empty() {
                format_whole_file_diff(Some(&display_path), Some(&display_path), old_text, false)?
            } else {
                create_unified_diff(&display_path, old_text, new_text)
            }
        }
    };
    diff.contains("@@ ").then_some(diff)
}

fn format_whole_file_diff(
    old_header_path: Option<&str>,
    new_header_path: Option<&str>,
    content: &str,
    added: bool,
) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return None;
    }
    let old_header = old_header_path
        .map(|p| format!("--- a/{p}"))
        .unwrap_or_else(|| "--- /dev/null".to_string());
    let new_header = new_header_path
        .map(|p| format!("+++ b/{p}"))
        .unwrap_or_else(|| "+++ /dev/null".to_string());
    let hunk_header = if added {
        format!("@@ -0,0 +1,{} @@", lines.len())
    } else {
        format!("@@ -1,{} +0,0 @@", lines.len())
    };
    let prefix = if added { '+' } else { '-' };
    let mut out = String::with_capacity(
        old_header.len() + new_header.len() + hunk_header.len() + content.len() + lines.len() + 8,
    );
    out.push_str(&old_header);
    out.push('\n');
    out.push_str(&new_header);
    out.push('\n');
    out.push_str(&hunk_header);
    out.push('\n');
    for line in lines {
        out.push(prefix);
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

fn count_unified_diff_lines(unified_diff: &str) -> (usize, usize) {
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for line in unified_diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn build_enriched_input_preview(
    original_raw_input: Option<&serde_json::Value>,
    raw_path: &str,
    before: &FileSnapshot,
    after: &FileSnapshot,
) -> Option<String> {
    let unified_diff = build_unified_diff_from_snapshots(raw_path, before, after)?;
    Some(serialize_enriched_input(
        original_raw_input,
        raw_path,
        &unified_diff,
        JSON_PREVIEW_BUDGET_BYTES,
    ))
}

fn base_object_from_raw_input(
    original_raw_input: Option<&serde_json::Value>,
    raw_path: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = match original_raw_input.and_then(serde_json::Value::as_object) {
        Some(existing) => existing.clone(),
        None => serde_json::Map::new(),
    };
    if !PATH_KEYS.iter().any(|key| {
        map.get(*key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    }) {
        map.insert(
            "file_path".to_string(),
            serde_json::Value::String(raw_path.to_string()),
        );
    }
    map
}

fn serialize_enriched_input(
    original_raw_input: Option<&serde_json::Value>,
    raw_path: &str,
    unified_diff: &str,
    budget_bytes: usize,
) -> String {
    let mut full_obj = base_object_from_raw_input(original_raw_input, raw_path);
    full_obj.insert(
        "unified_diff".to_string(),
        serde_json::Value::String(unified_diff.to_string()),
    );
    if let Ok(serialized) = serde_json::to_string(&full_obj)
        && serialized.len() <= budget_bytes
    {
        return serialized;
    }

    let (additions, deletions) = count_unified_diff_lines(unified_diff);
    let mut base_obj = base_object_from_raw_input(original_raw_input, raw_path);
    base_obj.insert("additions".to_string(), serde_json::json!(additions));
    base_obj.insert("deletions".to_string(), serde_json::json!(deletions));
    base_obj.insert("diff_truncated".to_string(), serde_json::Value::Bool(true));

    // If original_raw_input carries huge unrelated fields that already blow the
    // preview budget, fall back to a minimal object so the JSON never breaks.
    let probe = {
        let mut copy = base_obj.clone();
        copy.insert(
            "unified_diff".to_string(),
            serde_json::Value::String(String::new()),
        );
        serde_json::to_string(&copy)
            .map(|s| s.len())
            .unwrap_or(usize::MAX)
    };
    if probe > budget_bytes {
        base_obj.clear();
        base_obj.insert(
            "file_path".to_string(),
            serde_json::Value::String(raw_path.to_string()),
        );
        base_obj.insert("additions".to_string(), serde_json::json!(additions));
        base_obj.insert("deletions".to_string(), serde_json::json!(deletions));
        base_obj.insert("diff_truncated".to_string(), serde_json::Value::Bool(true));
    }

    let line_ends: Vec<usize> = unified_diff
        .match_indices('\n')
        .map(|(idx, _)| idx + 1)
        .collect();

    let mut best_slice = "";
    if !line_ends.is_empty() {
        let mut lo = 0usize;
        let mut hi = line_ends.len();
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            let candidate = &unified_diff[..line_ends[mid - 1]];
            let mut trial = base_obj.clone();
            trial.insert(
                "unified_diff".to_string(),
                serde_json::Value::String(candidate.to_string()),
            );
            let fits = serde_json::to_string(&trial)
                .is_ok_and(|serialized| serialized.len() <= budget_bytes);
            if fits {
                best_slice = candidate;
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
    }

    if best_slice.is_empty() {
        // Handle a single giant line without newlines via UTF-8 boundary search.
        let mut boundaries: Vec<usize> = unified_diff.char_indices().map(|(i, _)| i).collect();
        boundaries.push(unified_diff.len());
        let mut lo = 0usize;
        let mut hi = boundaries.len().saturating_sub(1);
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            let candidate = &unified_diff[..boundaries[mid]];
            let mut trial = base_obj.clone();
            trial.insert(
                "unified_diff".to_string(),
                serde_json::Value::String(candidate.to_string()),
            );
            let fits = serde_json::to_string(&trial)
                .is_ok_and(|serialized| serialized.len() <= budget_bytes);
            if fits {
                best_slice = candidate;
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
    }

    base_obj.insert(
        "unified_diff".to_string(),
        serde_json::Value::String(best_slice.to_string()),
    );
    serde_json::to_string(&base_obj).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn build_unified_diff_handles_modify_create_delete_and_empty() {
        let modified = build_unified_diff_from_snapshots(
            "src/app.ts",
            &FileSnapshot::Text("const a = 1;\nconst b = 2;\n".into()),
            &FileSnapshot::Text("const a = 1;\nconst b = 3;\nconst c = 4;\n".into()),
        )
        .expect("modified diff");
        assert!(modified.contains("--- a/src/app.ts"));
        assert!(modified.contains("+++ b/src/app.ts"));
        assert!(modified.contains("@@ "));
        assert_eq!(count_unified_diff_lines(&modified), (2, 1));

        let created = build_unified_diff_from_snapshots(
            "src/new.ts",
            &FileSnapshot::Missing,
            &FileSnapshot::Text("line1\nline2\n".into()),
        )
        .expect("created diff");
        assert!(created.starts_with("--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n"));
        assert_eq!(count_unified_diff_lines(&created), (2, 0));

        let deleted = build_unified_diff_from_snapshots(
            "src/old.ts",
            &FileSnapshot::Text("alpha\nbeta\ngamma".into()),
            &FileSnapshot::Missing,
        )
        .expect("deleted diff");
        assert!(deleted.starts_with("--- a/src/old.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n"));
        assert_eq!(count_unified_diff_lines(&deleted), (0, 3));

        let from_empty = build_unified_diff_from_snapshots(
            "src/empty.ts",
            &FileSnapshot::Text(String::new()),
            &FileSnapshot::Text("hello".into()),
        )
        .expect("from empty diff");
        assert_eq!(count_unified_diff_lines(&from_empty), (1, 0));

        assert!(
            build_unified_diff_from_snapshots(
                "src/same.ts",
                &FileSnapshot::Text("same\n".into()),
                &FileSnapshot::Text("same\n".into()),
            )
            .is_none()
        );
        assert!(
            build_unified_diff_from_snapshots(
                "bin/app.png",
                &FileSnapshot::Skipped,
                &FileSnapshot::Text("x".into()),
            )
            .is_none()
        );
    }

    #[test]
    fn serialize_enriched_input_truncates_large_diffs_with_exact_counts() {
        let mut big = String::from("--- a/big.ts\n+++ b/big.ts\n@@ -1,0 +1,800 @@\n");
        for i in 0..800 {
            big.push_str(&format!(
                "+const line_{i} = 'payload_value_for_diff_budget';\n"
            ));
        }
        let serialized = serialize_enriched_input(
            Some(&json!({ "file_path": "big.ts" })),
            "big.ts",
            &big,
            4096,
        );
        assert!(serialized.len() <= 4096);
        let parsed: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed["file_path"], "big.ts");
        assert_eq!(parsed["diff_truncated"], true);
        assert_eq!(parsed["additions"], 800);
        assert_eq!(parsed["deletions"], 0);
        let diff_str = parsed["unified_diff"].as_str().unwrap();
        assert!(!diff_str.is_empty());
        assert!(diff_str.ends_with('\n'));
    }

    #[test]
    fn structured_diff_detection_ignores_antigravity_path_only_inputs() {
        assert!(!has_structured_diff_or_content(
            Some(&json!({ "file_path": "/repo/a.ts" })),
            &[]
        ));
        assert!(has_structured_diff_or_content(
            Some(&json!({ "file_path": "/repo/a.ts", "oldText": "", "newText": "x" })),
            &[]
        ));
        assert!(has_structured_diff_or_content(
            Some(&json!({ "file_path": "/repo/a.ts", "unified_diff": "--- a/x\n+++ b/x\n" })),
            &[]
        ));
        assert!(has_structured_diff_or_content(
            None,
            &[ToolCallContent::Diff(acp::schema::v1::Diff::new(
                "/repo/a.ts",
                "new",
            ))]
        ));
    }
}
