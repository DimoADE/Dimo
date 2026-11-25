//! Realtime `ConversationRowOpBatch` coalescer (`<= 60 FPS`).
//!
//! Coalesces high-frequency streaming `Upsert` / `AppendText` / `PatchBlocks` updates
//! in-place per `(conversation_id, row_id)` over a `16ms` window (`MAX_PENDING_UPDATES = 512`,
//! `MAX_PENDING_BYTES = 64 KiB`), while flushing immediately on terminal turn events,
//! `Delete` tombstones, `reset: true` barriers, or explicit `flush_conversation` calls.

use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};

use agents::conversation::{
    ContentBlock, ConversationRowOp, ConversationRowOpBatch, ConversationTimelineRow,
    TimelineTextStream, TurnUsage,
};
use tokio::{task::AbortHandle, time::Instant};
use uuid::Uuid;

use crate::live_pipeline::ConversationEventSink;

pub const COALESCE_WINDOW: Duration = Duration::from_millis(16);
pub const MAX_PENDING_UPDATES: usize = 512;
pub const MAX_PENDING_BYTES: usize = 64 * 1024;

struct PendingBatch {
    batch: ConversationRowOpBatch,
    emit_global: bool,
    pending_updates: usize,
    pending_bytes: usize,
    timer_abort: Option<AbortHandle>,
}

#[derive(Default)]
struct ConversationCoalesceSlot {
    generation: u64,
    next_allowed_at: Option<Instant>,
    pending: Option<PendingBatch>,
}

impl ConversationCoalesceSlot {
    fn take_pending_for_flush(&mut self, abort_timer: bool) -> Option<(ConversationRowOpBatch, bool)> {
        let mut pending = self.pending.take()?;
        pending.pending_updates = 0;
        pending.pending_bytes = 0;
        if let Some(abort) = pending.timer_abort.take()
            && abort_timer
        {
            abort.abort();
        }
        Some((pending.batch, pending.emit_global))
    }
}

pub struct LiveRowOpCoalescer {
    sink: Arc<dyn ConversationEventSink>,
    window: Duration,
    max_pending_updates: usize,
    max_pending_bytes: usize,
    slots: Arc<Mutex<HashMap<Uuid, Arc<Mutex<ConversationCoalesceSlot>>>>>,
}

impl LiveRowOpCoalescer {
    pub fn new(sink: Arc<dyn ConversationEventSink>) -> Self {
        Self::with_limits(
            sink,
            COALESCE_WINDOW,
            MAX_PENDING_UPDATES,
            MAX_PENDING_BYTES,
        )
    }

    pub fn with_config(
        sink: Arc<dyn ConversationEventSink>,
        window: Duration,
        max_pending_updates: usize,
    ) -> Self {
        Self::with_limits(sink, window, max_pending_updates, MAX_PENDING_BYTES)
    }

    pub fn with_limits(
        sink: Arc<dyn ConversationEventSink>,
        window: Duration,
        max_pending_updates: usize,
        max_pending_bytes: usize,
    ) -> Self {
        Self {
            sink,
            window,
            max_pending_updates: max_pending_updates.max(1),
            max_pending_bytes: max_pending_bytes.max(1),
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn slot_for(
        &self,
        conversation_id: Uuid,
        prune_now: Option<Instant>,
    ) -> Arc<Mutex<ConversationCoalesceSlot>> {
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(now) = prune_now
            && slots.len() > 64
        {
            slots.retain(|id, slot_arc| {
                if *id == conversation_id || Arc::strong_count(slot_arc) > 1 {
                    return true;
                }
                match slot_arc.try_lock() {
                    Ok(slot) => {
                        slot.pending.is_some()
                            || slot.next_allowed_at.is_some_and(|deadline| deadline > now)
                    }
                    Err(_) => true,
                }
            });
        }
        Arc::clone(
            slots
                .entry(conversation_id)
                .or_insert_with(|| Arc::new(Mutex::new(ConversationCoalesceSlot::default()))),
        )
    }

    /// Prune an idle slot only after the caller has released `slot_arc`'s lock so
    /// lock ordering is strictly `self.slots` -> `slot_arc.try_lock()`.
    fn maybe_remove_slot_if_idle(
        &self,
        conversation_id: Uuid,
        slot_arc: &Arc<Mutex<ConversationCoalesceSlot>>,
    ) {
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let should_remove = slots.get(&conversation_id).is_some_and(|existing| {
            Arc::ptr_eq(existing, slot_arc)
                && Arc::strong_count(existing) == 2
                && existing
                    .try_lock()
                    .is_ok_and(|slot| slot.pending.is_none() && slot.next_allowed_at.is_none())
        });
        if should_remove {
            slots.remove(&conversation_id);
        }
    }

    /// Submit a batch to the coalescer.
    ///
    /// - `immediate_barrier`: `true` for `reset: true`, terminal turn transitions, `Delete` ops,
    ///   or user/queue lifecycle transitions; cancels any pending timer and flushes immediately.
    /// - `is_streaming`: `true` when the batch carries streaming deltas/patches subject to the
    ///   `16ms` (`<= 60 FPS`) throttle window.
    pub fn submit(
        &self,
        conversation_id: Uuid,
        batch: ConversationRowOpBatch,
        emit_global: bool,
        immediate_barrier: bool,
        is_streaming: bool,
    ) {
        if batch.reset {
            let slot_arc = self.slot_for(conversation_id, None);
            {
                let mut slot = slot_arc
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let _ = slot.take_pending_for_flush(true);
                slot.next_allowed_at = None;
                slot.generation = slot.generation.wrapping_add(1);
                self.emit_now(conversation_id, &batch, true);
            }
            self.maybe_remove_slot_if_idle(conversation_id, &slot_arc);
            return;
        }

        let immediate_barrier = immediate_barrier || batch.ops.iter().any(is_barrier_op);
        if immediate_barrier || !is_streaming {
            let slot_arc = self.slot_for(conversation_id, None);
            {
                let mut slot = slot_arc
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if immediate_barrier {
                    slot.next_allowed_at = None;
                }
                let (out_batch, out_global) = if let Some((mut pending_batch, pending_global)) =
                    slot.take_pending_for_flush(true)
                {
                    merge_into_batch(&mut pending_batch, batch);
                    (pending_batch, pending_global || emit_global)
                } else {
                    (batch, emit_global)
                };
                slot.generation = slot.generation.wrapping_add(1);
                self.emit_now(conversation_id, &out_batch, out_global);
            }
            if immediate_barrier {
                self.maybe_remove_slot_if_idle(conversation_id, &slot_arc);
            }
            return;
        }

        let now = Instant::now();
        let incoming_weight = batch.ops.len().max(1);
        let incoming_bytes = estimate_batch_ops_bytes(&batch.ops);
        let slot_arc = self.slot_for(conversation_id, Some(now));
        let mut slot = slot_arc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Leading-edge emission when outside the 16ms window and nothing is buffered.
        let window_open = slot.next_allowed_at.is_none_or(|deadline| now >= deadline);
        if window_open && slot.pending.is_none() {
            slot.next_allowed_at = Some(now + self.window);
            slot.generation = slot.generation.wrapping_add(1);
            self.emit_now(conversation_id, &batch, emit_global);
            return;
        }

        let deadline = slot.next_allowed_at.unwrap_or(now + self.window);
        if slot.next_allowed_at.is_none() {
            slot.next_allowed_at = Some(deadline);
        }

        match slot.pending.as_mut() {
            Some(pending) => {
                merge_into_batch(&mut pending.batch, batch);
                pending.emit_global |= emit_global;
                pending.pending_updates = pending.pending_updates.saturating_add(incoming_weight);
                pending.pending_bytes = pending.pending_bytes.saturating_add(incoming_bytes);
            }
            None => {
                slot.pending = Some(PendingBatch {
                    batch,
                    emit_global,
                    pending_updates: incoming_weight,
                    pending_bytes: incoming_bytes,
                    timer_abort: None,
                });
            }
        }

        let over_cap = slot.pending.as_ref().is_some_and(|p| {
            p.pending_updates >= self.max_pending_updates
                || p.pending_bytes >= self.max_pending_bytes
        });
        if over_cap {
            let (out_batch, out_global) = slot
                .take_pending_for_flush(true)
                .expect("pending exists");
            slot.next_allowed_at = Some(now + self.window);
            slot.generation = slot.generation.wrapping_add(1);
            self.emit_now(conversation_id, &out_batch, out_global);
        } else {
            let expected_generation = slot.generation;
            if let Some(pending) = slot.pending.as_mut()
                && pending.timer_abort.is_none()
            {
                let abort = self.spawn_flush_timer(
                    conversation_id,
                    Arc::clone(&slot_arc),
                    expected_generation,
                    deadline,
                );
                pending.timer_abort = Some(abort);
            }
        }
    }

    /// Flush any buffered ops for `conversation_id` immediately (used before session detach/close).
    pub fn flush_conversation(&self, conversation_id: Uuid) {
        let slot_arc = {
            let slots = self
                .slots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slots.get(&conversation_id).cloned()
        };
        let Some(slot_arc) = slot_arc else {
            return;
        };
        {
            let mut slot = slot_arc
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slot.next_allowed_at = None;
            let pending = slot.take_pending_for_flush(true);
            slot.generation = slot.generation.wrapping_add(1);
            if let Some((batch, emit_global)) = pending {
                self.emit_now(conversation_id, &batch, emit_global);
            }
        }
        self.maybe_remove_slot_if_idle(conversation_id, &slot_arc);
    }

    fn spawn_flush_timer(
        &self,
        conversation_id: Uuid,
        slot_arc: Arc<Mutex<ConversationCoalesceSlot>>,
        expected_generation: u64,
        deadline: Instant,
    ) -> AbortHandle {
        let sink = Arc::clone(&self.sink);
        let window = self.window;
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let mut slot = slot_arc
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if slot.generation != expected_generation {
                return;
            }
            let Some((batch, emit_global)) = slot.take_pending_for_flush(false) else {
                return;
            };
            slot.generation = slot.generation.wrapping_add(1);
            slot.next_allowed_at = Some(Instant::now() + window);
            sink.emit_conversation_batch(conversation_id, &batch);
            if emit_global {
                sink.emit_global_batch(&batch);
            }
        })
        .abort_handle()
    }

    pub fn emit_workspaces_sessions_changed(
        &self,
        payload: crate::live_pipeline::WorkspaceSessionsChanged,
    ) {
        self.sink.emit_workspaces_sessions_changed(payload);
    }

    fn emit_now(&self, conversation_id: Uuid, batch: &ConversationRowOpBatch, emit_global: bool) {
        self.sink.emit_conversation_batch(conversation_id, batch);
        if emit_global {
            self.sink.emit_global_batch(batch);
        }
    }
}

#[derive(Default)]
struct ByteCountWriter(usize);

impl Write for ByteCountWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(buf.len());
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn is_barrier_op(op: &ConversationRowOp) -> bool {
    match op {
        ConversationRowOp::Delete { .. } => true,
        ConversationRowOp::Upsert { row } => matches!(
            &row.row,
            ConversationTimelineRow::MessageTurn { phase, .. } if phase == "settled"
        ),
        _ => false,
    }
}

fn estimate_row_op_bytes(op: &ConversationRowOp) -> usize {
    match op {
        ConversationRowOp::AppendText { row_id, delta, .. } => 48usize
            .saturating_add(row_id.len())
            .saturating_add(delta.len()),
        ConversationRowOp::Delete { row_id, .. } => 32usize.saturating_add(row_id.len()),
        ConversationRowOp::Upsert { .. } | ConversationRowOp::PatchBlocks { .. } => {
            let mut counter = ByteCountWriter::default();
            let _ = serde_json::to_writer(&mut counter, op);
            counter.0.max(64)
        }
    }
}

fn estimate_batch_ops_bytes(ops: &[ConversationRowOp]) -> usize {
    ops.iter()
        .fold(0usize, |acc, op| {
            acc.saturating_add(estimate_row_op_bytes(op))
        })
        .max(1)
}

fn op_row_id(op: &ConversationRowOp) -> &str {
    match op {
        ConversationRowOp::Upsert { row } => &row.row_id,
        ConversationRowOp::Delete { row_id, .. } => row_id,
        ConversationRowOp::AppendText { row_id, .. } => row_id,
        ConversationRowOp::PatchBlocks { row_id, .. } => row_id,
    }
}

/// Merge `incoming` into `target` in-place, coalescing streaming `Upsert`, `AppendText`,
/// and `PatchBlocks` per `row_id`.
pub fn merge_into_batch(target: &mut ConversationRowOpBatch, incoming: ConversationRowOpBatch) {
    target.last_sequence = target.last_sequence.max(incoming.last_sequence);
    if target.previous_sequence.is_none() {
        target.previous_sequence = incoming.previous_sequence;
    }
    target.live_sequence = match (target.live_sequence, incoming.live_sequence) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    target.reset |= incoming.reset;
    if incoming.session_modes.is_some() {
        target.session_modes = incoming.session_modes;
    }
    if incoming.session_config_options.is_some() {
        target.session_config_options = incoming.session_config_options;
    }
    if incoming.available_commands.is_some() {
        target.available_commands = incoming.available_commands;
    }
    if incoming.session_goal.is_some() {
        target.session_goal = incoming.session_goal;
    }
    if incoming.async_tasks.is_some() {
        target.async_tasks = incoming.async_tasks;
    }
    if incoming.prompt_suggestion.is_some() {
        target.prompt_suggestion = incoming.prompt_suggestion;
    }
    coalesce_row_ops_in_place(&mut target.ops, incoming.ops);
}

pub fn coalesce_row_ops_in_place(
    ops: &mut Vec<ConversationRowOp>,
    incoming: impl IntoIterator<Item = ConversationRowOp>,
) {
    for op in incoming {
        match op {
            ConversationRowOp::Upsert { row } => {
                ops.retain(|existing| op_row_id(existing) != row.row_id);
                ops.push(ConversationRowOp::Upsert { row });
            }
            ConversationRowOp::Delete { row_id, revision } => {
                ops.retain(|existing| op_row_id(existing) != row_id);
                ops.push(ConversationRowOp::Delete { row_id, revision });
            }
            ConversationRowOp::AppendText {
                row_id,
                revision,
                stream,
                delta,
            } => {
                if let Some(last_idx) = ops.iter().rposition(|o| op_row_id(o) == row_id) {
                    match &mut ops[last_idx] {
                        ConversationRowOp::AppendText {
                            revision: prev_rev,
                            stream: prev_stream,
                            delta: prev_delta,
                            ..
                        } if *prev_stream == stream => {
                            prev_delta.push_str(&delta);
                            *prev_rev = revision;
                            continue;
                        }
                        ConversationRowOp::Upsert { row } => {
                            if let ConversationTimelineRow::MessageTurn { turn, .. } = &mut row.row
                            {
                                append_delta_to_blocks(&mut turn.blocks, stream, &delta);
                                row.revision = revision;
                                continue;
                            }
                        }
                        _ => {}
                    }
                }
                ops.push(ConversationRowOp::AppendText {
                    row_id,
                    revision,
                    stream,
                    delta,
                });
            }
            ConversationRowOp::PatchBlocks {
                row_id,
                revision,
                phase,
                blocks,
                usage,
            } => {
                if let Some(last_idx) = ops.iter().rposition(|o| op_row_id(o) == row_id) {
                    match &mut ops[last_idx] {
                        ConversationRowOp::PatchBlocks {
                            revision: prev_rev,
                            phase: prev_phase,
                            blocks: prev_blocks,
                            usage: prev_usage,
                            ..
                        } => {
                            merge_patched_blocks(prev_blocks, blocks);
                            *prev_phase = phase;
                            *prev_rev = revision;
                            *prev_usage = merge_optional_usage(prev_usage.take(), usage);
                            continue;
                        }
                        ConversationRowOp::Upsert { row } => {
                            if let ConversationTimelineRow::MessageTurn {
                                turn,
                                phase: row_phase,
                                ..
                            } = &mut row.row
                            {
                                merge_patched_blocks(&mut turn.blocks, blocks);
                                *row_phase = phase;
                                turn.usage = merge_optional_usage(turn.usage.take(), usage);
                                row.revision = revision;
                                continue;
                            }
                        }
                        _ => {}
                    }
                }
                ops.push(ConversationRowOp::PatchBlocks {
                    row_id,
                    revision,
                    phase,
                    blocks,
                    usage,
                });
            }
        }
    }
}

fn append_delta_to_blocks(blocks: &mut Vec<ContentBlock>, stream: TimelineTextStream, delta: &str) {
    match stream {
        TimelineTextStream::Text => {
            if let Some(ContentBlock::Text { text }) = blocks.last_mut() {
                text.push_str(delta);
            } else {
                blocks.push(ContentBlock::Text {
                    text: delta.to_string(),
                });
            }
        }
        TimelineTextStream::Reasoning => {
            if let Some(ContentBlock::Thinking { text }) = blocks.last_mut() {
                text.push_str(delta);
            } else {
                blocks.push(ContentBlock::Thinking {
                    text: delta.to_string(),
                });
            }
        }
    }
}

fn merge_patched_blocks(existing: &mut Vec<ContentBlock>, incoming: Vec<ContentBlock>) {
    for block in incoming {
        match &block {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                ..
            } => {
                if let Some(slot) = existing.iter_mut().find(|b| {
                    matches!(
                        b,
                        ContentBlock::ToolUse {
                            tool_use_id: Some(existing_id),
                            ..
                        } if existing_id == id
                    )
                }) {
                    *slot = block;
                    continue;
                }
            }
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                ..
            } => {
                if let Some(slot) = existing.iter_mut().find(|b| {
                    matches!(
                        b,
                        ContentBlock::ToolResult {
                            tool_use_id: Some(existing_id),
                            ..
                        } if existing_id == id
                    )
                }) {
                    *slot = block;
                    continue;
                }
            }
            ContentBlock::Plan { .. } => {
                if let Some(slot) = existing
                    .iter_mut()
                    .rev()
                    .find(|b| matches!(b, ContentBlock::Plan { .. }))
                {
                    *slot = block;
                    continue;
                }
            }
            _ => {}
        }
        existing.push(block);
    }
}

fn merge_optional_usage(
    existing: Option<TurnUsage>,
    incoming: Option<TurnUsage>,
) -> Option<TurnUsage> {
    match (existing, incoming) {
        (None, None) => None,
        (Some(prev), None) => Some(prev),
        (None, Some(next)) => Some(next),
        (Some(prev), Some(next)) => {
            let keep_buckets = next.input_tokens == 0
                && next.output_tokens == 0
                && next.cache_creation_input_tokens == 0
                && next.cache_read_input_tokens == 0;
            Some(TurnUsage {
                input_tokens: if keep_buckets {
                    prev.input_tokens
                } else {
                    next.input_tokens
                },
                output_tokens: if keep_buckets {
                    prev.output_tokens
                } else {
                    next.output_tokens
                },
                cache_creation_input_tokens: if keep_buckets {
                    prev.cache_creation_input_tokens
                } else {
                    next.cache_creation_input_tokens
                },
                cache_read_input_tokens: if keep_buckets {
                    prev.cache_read_input_tokens
                } else {
                    next.cache_read_input_tokens
                },
                context_used: next.context_used.or(prev.context_used),
                context_window_max: next.context_window_max.or(prev.context_window_max),
                cost_amount: next.cost_amount.or(prev.cost_amount),
                cost_currency: next.cost_currency.or(prev.cost_currency),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use agents::conversation::{MessageTurn, TimelineRow, TurnRole};
    use chrono::Utc;

    use super::*;
    use crate::live_pipeline::WorkspaceSessionsChanged;

    struct TestSink {
        emitted: Arc<Mutex<Vec<ConversationRowOpBatch>>>,
    }

    impl ConversationEventSink for TestSink {
        fn emit_conversation_batch(&self, _conversation_id: Uuid, batch: &ConversationRowOpBatch) {
            self.emitted.lock().unwrap().push(batch.clone());
        }

        fn emit_global_batch(&self, _batch: &ConversationRowOpBatch) {}

        fn emit_workspaces_sessions_changed(&self, _payload: WorkspaceSessionsChanged) {}
    }

    fn empty_batch(
        cid: Uuid,
        prev: i64,
        last: i64,
        ops: Vec<ConversationRowOp>,
    ) -> ConversationRowOpBatch {
        ConversationRowOpBatch {
            conversation_id: cid,
            last_sequence: last,
            previous_sequence: Some(prev),
            live_sequence: None,
            reset: false,
            ops,
            session_modes: None,
            session_config_options: None,
            available_commands: None,
            session_goal: None,
            async_tasks: None,
            prompt_suggestion: None,
        }
    }

    #[tokio::test]
    async fn coalesces_burst_within_16ms_window_and_caps_rate_at_60_fps() {
        assert_eq!(COALESCE_WINDOW, Duration::from_millis(16));
        assert_eq!(MAX_PENDING_UPDATES, 512);
        assert_eq!(MAX_PENDING_BYTES, 64 * 1024);

        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        let coalescer = LiveRowOpCoalescer::new(sink);
        let cid = Uuid::new_v4();

        // Delta 1 emits on leading edge; deltas 2..=40 coalesce in-place inside the 16ms window.
        for seq in 1..=40 {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        stream: TimelineTextStream::Text,
                        delta: "x".into(),
                    }],
                ),
                false,
                false,
                true,
            );
        }

        assert_eq!(
            emitted.lock().unwrap().len(),
            1,
            "only leading edge emitted before 16ms"
        );
        tokio::time::sleep(Duration::from_millis(45)).await;

        let batches = emitted.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            2,
            "trailing 16ms timer emits 1 merged batch (<= 60 FPS)"
        );
        assert_eq!(batches[1].previous_sequence, Some(1));
        assert_eq!(batches[1].last_sequence, 40);
        assert_eq!(batches[1].ops.len(), 1);
        match &batches[1].ops[0] {
            ConversationRowOp::AppendText {
                delta, revision, ..
            } => {
                assert_eq!(delta.len(), 39);
                assert_eq!(*revision, 40);
            }
            other => panic!("expected coalesced AppendText, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn terminal_barrier_delete_and_reset_flush_immediately_and_patch_blocks_merge_in_place() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        // Use a 10s window to prove zero-delay barrier passthrough without timer expiry.
        let coalescer =
            LiveRowOpCoalescer::with_config(sink, Duration::from_secs(10), MAX_PENDING_UPDATES);
        let cid = Uuid::new_v4();

        // Leading edge delta
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                0,
                1,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 1,
                    stream: TimelineTextStream::Text,
                    delta: "hel".into(),
                }],
            ),
            false,
            false,
            true,
        );

        // Buffered PatchBlocks #1 + PatchBlocks #2 for same tool_use_id
        for (seq, status) in [(2, "in_progress"), (3, "completed")] {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::PatchBlocks {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        phase: "streaming".into(),
                        blocks: vec![ContentBlock::ToolUse {
                            tool_use_id: Some("tool-1".into()),
                            tool_name: "bash".into(),
                            status: Some(status.into()),
                            kind: None,
                            input_preview: None,
                            meta: None,
                            images: Vec::new(),
                            started_at: None,
                            ended_at: None,
                        }],
                        usage: None,
                    }],
                ),
                false,
                false,
                true,
            );
        }
        assert_eq!(
            emitted.lock().unwrap().len(),
            1,
            "patches stay buffered while inside throttle window"
        );

        // Terminal TurnCompleted / settled Upsert arrives -> flushes immediately with zero delay!
        let settled_row = TimelineRow {
            row_id: "t1:assistant".into(),
            revision: 4,
            row: ConversationTimelineRow::MessageTurn {
                turn: MessageTurn {
                    id: "t1:assistant".into(),
                    role: TurnRole::Assistant,
                    blocks: vec![ContentBlock::Text {
                        text: "hello".into(),
                    }],
                    timestamp: Utc::now(),
                    usage: None,
                    duration_ms: Some(12),
                    model: None,
                    completed_at: Some(Utc::now()),
                    agent_message_id: None,
                },
                phase: "settled".into(),
                fork_point_status: None,
            },
        };
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                3,
                4,
                vec![ConversationRowOp::Upsert { row: settled_row }],
            ),
            true,
            true,
            false,
        );

        let batches = emitted.lock().unwrap().clone();
        assert_eq!(batches.len(), 2, "terminal barrier flushed immediately");
        assert_eq!(batches[1].previous_sequence, Some(1));
        assert_eq!(batches[1].last_sequence, 4);
        assert_eq!(
            batches[1].ops.len(),
            1,
            "settled Upsert superseded buffered PatchBlocks"
        );

        // Next streaming delta emits on leading edge (because terminal barrier cleared cooldown),
        // then second delta buffers, then `Delete` tombstone flushes immediately with zero delay!
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                4,
                5,
                vec![ConversationRowOp::AppendText {
                    row_id: "t2:assistant".into(),
                    revision: 5,
                    stream: TimelineTextStream::Text,
                    delta: "temp".into(),
                }],
            ),
            false,
            false,
            true,
        );
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                5,
                6,
                vec![ConversationRowOp::AppendText {
                    row_id: "t2:assistant".into(),
                    revision: 6,
                    stream: TimelineTextStream::Text,
                    delta: " tail".into(),
                }],
            ),
            false,
            false,
            true,
        );
        assert_eq!(emitted.lock().unwrap().len(), 3, "t2 tail buffered");

        coalescer.submit(
            cid,
            empty_batch(
                cid,
                6,
                7,
                vec![ConversationRowOp::Delete {
                    row_id: "t2:assistant".into(),
                    revision: 7,
                }],
            ),
            true,
            false,
            true,
        );
        let batches = emitted.lock().unwrap().clone();
        assert_eq!(batches.len(), 4, "Delete tombstone flushed immediately");
        assert!(matches!(
            &batches[3].ops[..],
            [ConversationRowOp::Delete { row_id, revision: 7 }] if row_id == "t2:assistant"
        ));

        // Reset barrier cancels any buffered work and emits `reset: true` immediately.
        let mut reset_batch = empty_batch(cid, 7, 8, Vec::new());
        reset_batch.reset = true;
        coalescer.submit(cid, reset_batch, true, true, false);
        let batches = emitted.lock().unwrap().clone();
        assert_eq!(batches.len(), 5);
        assert!(batches[4].reset);
    }

    #[tokio::test]
    async fn max_pending_updates_forces_immediate_flush() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        let coalescer = LiveRowOpCoalescer::with_config(sink, Duration::from_secs(10), 4);
        let cid = Uuid::new_v4();

        for seq in 1..=5 {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        stream: TimelineTextStream::Text,
                        delta: "a".into(),
                    }],
                ),
                false,
                false,
                true,
            );
        }
        // seq 1 = leading edge, seq 2..=5 (4 updates == cap) = immediate cap flush!
        assert_eq!(emitted.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn max_pending_bytes_forces_immediate_flush_before_timer_expiry() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        // 10s window guarantees any flush comes from MAX_PENDING_BYTES, not timer expiry.
        let coalescer =
            LiveRowOpCoalescer::with_config(sink, Duration::from_secs(10), MAX_PENDING_UPDATES);
        let cid = Uuid::new_v4();

        // seq 1: leading edge
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                0,
                1,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 1,
                    stream: TimelineTextStream::Text,
                    delta: "lead".into(),
                }],
            ),
            false,
            false,
            true,
        );
        assert_eq!(emitted.lock().unwrap().len(), 1);

        // seq 2..=4: 3 * 20 KiB = ~60 KiB (< MAX_PENDING_BYTES = 64 KiB) -> stays buffered
        let chunk_20k = "a".repeat(20 * 1024);
        for seq in 2..=4 {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        stream: TimelineTextStream::Text,
                        delta: chunk_20k.clone(),
                    }],
                ),
                false,
                false,
                true,
            );
        }
        assert_eq!(
            emitted.lock().unwrap().len(),
            1,
            "60 KiB buffered below 64 KiB high-water mark"
        );

        // seq 5: +8 KiB -> ~68 KiB >= MAX_PENDING_BYTES -> flushes immediately before timer expiry!
        let chunk_8k = "b".repeat(8 * 1024);
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                4,
                5,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 5,
                    stream: TimelineTextStream::Text,
                    delta: chunk_8k,
                }],
            ),
            false,
            false,
            true,
        );
        let batches = emitted.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            2,
            "exceeding MAX_PENDING_BYTES flushes immediately before timer expiry"
        );
        match &batches[1].ops[0] {
            ConversationRowOp::AppendText {
                delta, revision, ..
            } => {
                assert_eq!(delta.len(), 3 * 20 * 1024 + 8 * 1024);
                assert_eq!(*revision, 5);
            }
            other => panic!("expected coalesced AppendText, got {other:?}"),
        }

        // Verify `pending_bytes` was reset to 0 on flush: a small follow-up delta stays buffered.
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                5,
                6,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 6,
                    stream: TimelineTextStream::Text,
                    delta: "small".into(),
                }],
            ),
            false,
            false,
            true,
        );
        assert_eq!(
            emitted.lock().unwrap().len(),
            2,
            "pending_bytes reset to 0 after flush so small follow-up stays buffered"
        );
    }

    struct BlockingOnSeqSink {
        pause_on_seq: i64,
        paused_tx: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
        release_rx: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        emitted: Arc<Mutex<Vec<ConversationRowOpBatch>>>,
    }

    impl ConversationEventSink for BlockingOnSeqSink {
        fn emit_conversation_batch(&self, _cid: Uuid, batch: &ConversationRowOpBatch) {
            if batch.last_sequence == self.pause_on_seq
                && !batch.reset
                && let Some(tx) = self.paused_tx.lock().unwrap().take()
            {
                let _ = tx.send(());
                if let Some(rx) = self.release_rx.lock().unwrap().take() {
                    let _ = rx.recv_timeout(Duration::from_secs(2));
                }
            }
            self.emitted.lock().unwrap().push(batch.clone());
        }

        fn emit_global_batch(&self, _batch: &ConversationRowOpBatch) {}

        fn emit_workspaces_sessions_changed(
            &self,
            _payload: crate::live_pipeline::WorkspaceSessionsChanged,
        ) {
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timer_flush_never_emits_after_reset_barrier_or_flush() {
        for mode in ["reset", "immediate_barrier", "flush_conversation"] {
            let cid = Uuid::new_v4();
            let emitted = Arc::new(Mutex::new(Vec::new()));
            let (paused_tx, paused_rx) = std::sync::mpsc::sync_channel(1);
            let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
            let sink = Arc::new(BlockingOnSeqSink {
                pause_on_seq: 2,
                paused_tx: Mutex::new(Some(paused_tx)),
                release_rx: Mutex::new(Some(release_rx)),
                emitted: Arc::clone(&emitted),
            });
            let coalescer = Arc::new(LiveRowOpCoalescer::with_config(
                sink,
                Duration::from_millis(15),
                16,
            ));

            // seq 1: leading edge
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    0,
                    1,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: 1,
                        stream: TimelineTextStream::Text,
                        delta: "lead".into(),
                    }],
                ),
                false,
                false,
                true,
            );
            // seq 2: buffered, arms timer
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    1,
                    2,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: 2,
                        stream: TimelineTextStream::Text,
                        delta: "buffered".into(),
                    }],
                ),
                false,
                false,
                true,
            );

            // Wait until the timer task has fired and entered emit_conversation_batch(seq=2).
            paused_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("timer flush should start");

            let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
            let c2 = Arc::clone(&coalescer);
            let handle = std::thread::spawn(move || {
                match mode {
                    "reset" => {
                        let mut reset = empty_batch(cid, 2, 1, vec![]);
                        reset.reset = true;
                        c2.submit(cid, reset, true, true, false);
                    }
                    "immediate_barrier" => {
                        c2.submit(
                            cid,
                            empty_batch(
                                cid,
                                2,
                                3,
                                vec![ConversationRowOp::Delete {
                                    row_id: "t1:assistant".into(),
                                    revision: 3,
                                }],
                            ),
                            true,
                            true,
                            false,
                        );
                    }
                    "flush_conversation" => {
                        c2.flush_conversation(cid);
                    }
                    _ => unreachable!(),
                }
                let _ = done_tx.send(());
            });

            // While the timer holds the per-conversation emit lock, the concurrent
            // reset / barrier / flush must NOT overtake it and finish early.
            assert!(
                done_rx.recv_timeout(Duration::from_millis(40)).is_err(),
                "{mode} must wait for in-flight timer emission instead of overtaking it"
            );

            // Let the timer finish emitting seq=2.
            release_tx.send(()).expect("release timer");
            handle.join().expect("join concurrent caller");

            let batches = emitted.lock().unwrap().clone();
            match mode {
                "reset" => {
                    assert_eq!(batches.len(), 3, "expected seq1, timer seq2, then reset");
                    assert_eq!(batches[1].last_sequence, 2);
                    assert!(!batches[1].reset);
                    assert!(batches[2].reset, "reset must be the final batch");
                }
                "immediate_barrier" => {
                    assert_eq!(batches.len(), 3, "expected seq1, timer seq2, then barrier seq3");
                    assert_eq!(batches[1].last_sequence, 2);
                    assert_eq!(batches[2].last_sequence, 3);
                }
                "flush_conversation" => {
                    assert_eq!(batches.len(), 2, "flush_conversation waited for timer seq2");
                    assert_eq!(batches[1].last_sequence, 2);
                }
                _ => unreachable!(),
            }
        }
    }
}
