//! Application diagnostic logging built on `tracing`.
//!
//! One subscriber feeds three sinks: stderr, a daily-rotating text file under
//! [`utils::assets::logs_dir`], and an in-memory ring buffer read and live-tailed
//! by the Settings -> Logs viewer (`get_recent_logs` + `logs://appended`).

use std::{
    cell::Cell,
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    EnvFilter, Registry, fmt,
    layer::{Context, Layer},
    prelude::*,
    reload,
};

pub const LOG_APPENDED_EVENT: &str = "logs://appended";
pub const LOG_BUFFER_MAX_COUNT: usize = 5_000;
pub const LOG_BUFFER_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    All,
    Off,
    Error,
    Warn,
    #[default]
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    pub fn directive(self) -> &'static str {
        match self {
            LogLevel::All | LogLevel::Trace => "trace",
            LogLevel::Off => "off",
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetDirective {
    pub target: String,
    pub level: LogLevel,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LogSettings {
    pub level: LogLevel,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<TargetDirective>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogRecord {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: &'static str,
    pub target: String,
    pub message: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

const FIREHOSE_BACKSTOPS: &str = concat!(
    ",sqlx::query=warn,hyper=info,hyper_util=info,reqwest=info,h2=info,",
    "rustls=info,tokio=info,tower=info,want=info,mio=warn,notify=warn,",
    "tonic=info,h2::codec=warn,dimo::logging=off,server::desktop::logging=off"
);

const APP_LOG_PREFIXES: &[&str] = &[
    "agents",
    "application",
    "artifacts",
    "automation",
    "browser_host",
    "conversations",
    "db",
    "delegation",
    "executors",
    "git",
    "local_deployment",
    "plugins",
    "remote_protocol",
    "server",
    "services",
    "tool_runtime",
    "utils",
    "dimo",
    "workflows",
];

fn settings_path() -> std::path::PathBuf {
    utils::assets::asset_dir().join("logging.json")
}

pub fn load_persisted_settings() -> LogSettings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn env_level_override() -> Option<String> {
    ["DIMO_LOG", "RUST_LOG"].iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

pub fn is_valid_target(target: &str) -> bool {
    if target.is_empty()
        || target == "dimo::logging"
        || target.starts_with("dimo::logging::")
        || target == "server::desktop::logging"
        || target.starts_with("server::desktop::logging::")
    {
        return false;
    }
    target
        .split("::")
        .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

pub fn build_env_filter(settings: &LogSettings) -> EnvFilter {
    let mut directives = settings.level.directive().to_string();
    for target_rule in &settings.targets {
        let target = target_rule.target.trim();
        if is_valid_target(target) {
            directives.push_str(&format!(",{target}={}", target_rule.level.directive()));
        }
    }
    if settings.level != LogLevel::Off {
        directives.push_str(FIREHOSE_BACKSTOPS);
    }
    EnvFilter::builder().parse_lossy(directives)
}

fn estimate_size(rec: &LogRecord) -> usize {
    rec.target.len()
        + rec.message.len()
        + 48
        + rec
            .fields
            .iter()
            .map(|(k, v)| k.len() + v.len() + 16)
            .sum::<usize>()
}

struct RingBuffer {
    records: VecDeque<(usize, LogRecord)>,
    byte_total: usize,
}

impl RingBuffer {
    fn new() -> Self {
        Self {
            records: VecDeque::with_capacity(256),
            byte_total: 0,
        }
    }

    fn push(&mut self, rec: LogRecord) {
        let size = estimate_size(&rec);
        self.records.push_back((size, rec));
        self.byte_total = self.byte_total.saturating_add(size);
        while self.records.len() > LOG_BUFFER_MAX_COUNT || self.byte_total > LOG_BUFFER_MAX_BYTES {
            match self.records.pop_front() {
                Some((s, _)) => self.byte_total = self.byte_total.saturating_sub(s),
                None => break,
            }
        }
    }

    fn recent(&self, limit: usize) -> Vec<LogRecord> {
        let skip = self.records.len().saturating_sub(limit);
        self.records
            .iter()
            .skip(skip)
            .map(|(_, record)| record.clone())
            .collect()
    }
}

type ReloadFn = Box<dyn Fn(EnvFilter) -> Result<(), String> + Send + Sync>;

struct LogHub {
    seq: AtomicU64,
    buffer: Mutex<RingBuffer>,
    live_tail_active: AtomicBool,
    bus: RwLock<Option<Arc<crate::HostEventBus>>>,
    reload: RwLock<Option<ReloadFn>>,
}

impl LogHub {
    fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            buffer: Mutex::new(RingBuffer::new()),
            live_tail_active: AtomicBool::new(false),
            bus: RwLock::new(None),
            reload: RwLock::new(None),
        }
    }

    fn attach_bus(&self, bus: Arc<crate::HostEventBus>) {
        *self.bus.write().unwrap_or_else(|e| e.into_inner()) = Some(bus);
    }

    fn record_and_emit(&self, record: LogRecord) {
        let emit_record = {
            let mut buffer = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
            if self.live_tail_active.load(Ordering::Acquire) {
                buffer.push(record.clone());
                Some(record)
            } else {
                buffer.push(record);
                None
            }
        };
        if let Some(record) = emit_record {
            let bus = self.bus.read().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(bus) = bus
                && bus.has_subscribers()
            {
                bus.emit(LOG_APPENDED_EVENT, &record);
            }
        }
    }

    fn recent_logs(&self, limit: usize) -> Vec<LogRecord> {
        let buffer = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        self.live_tail_active.store(true, Ordering::Release);
        buffer.recent(limit)
    }
}

static LOG_HUB: OnceLock<Arc<LogHub>> = OnceLock::new();

fn log_hub() -> Option<&'static Arc<LogHub>> {
    LOG_HUB.get()
}

fn ensure_hub() -> &'static Arc<LogHub> {
    LOG_HUB.get_or_init(|| Arc::new(LogHub::new()))
}

pub fn attach_event_bus(bus: Arc<crate::HostEventBus>) {
    ensure_hub().attach_bus(bus);
}

pub fn apply_live_settings(settings: &LogSettings) {
    if env_level_override().is_some() {
        return;
    }
    let Some(hub) = log_hub() else {
        return;
    };
    let filter = build_env_filter(settings);
    if let Some(reload_fn) = hub
        .reload
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        && let Err(error) = reload_fn(filter)
    {
        eprintln!("[logging] failed to reload tracing filter: {error}");
    }
}

pub fn recent_logs(limit: usize) -> Vec<LogRecord> {
    let Some(hub) = log_hub() else {
        return Vec::new();
    };
    hub.recent_logs(limit)
}

thread_local! {
    static IN_LAYER: Cell<bool> = const { Cell::new(false) };
}

struct LayerGuard;

impl LayerGuard {
    fn enter() -> Option<Self> {
        if IN_LAYER.with(|flag| flag.replace(true)) {
            None
        } else {
            Some(LayerGuard)
        }
    }
}

impl Drop for LayerGuard {
    fn drop(&mut self) {
        IN_LAYER.with(|flag| flag.set(false));
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: BTreeMap<String, String>,
}

impl FieldVisitor {
    fn put(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = Some(value);
        } else {
            self.fields.insert(field.name().to_string(), value);
        }
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, format!("{value:?}"));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, value.to_string());
    }
}

fn is_app_target(target: &str) -> bool {
    APP_LOG_PREFIXES.iter().any(|prefix| {
        target
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

struct BufferEmitLayer;

impl<S: Subscriber> Layer<S> for BufferEmitLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let Some(_guard) = LayerGuard::enter() else {
            return;
        };
        let Some(hub) = log_hub() else {
            return;
        };
        let meta = event.metadata();
        if *meta.level() == tracing::Level::TRACE && !is_app_target(meta.target()) {
            return;
        }
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let record = LogRecord {
            seq: hub.seq.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_ms(),
            level: meta.level().as_str(),
            target: meta.target().to_string(),
            message: visitor.message.unwrap_or_default(),
            fields: visitor.fields,
        };
        hub.record_and_emit(record);
    }
}

fn init_file_writer(
    dir: &Path,
) -> Option<(tracing_appender::non_blocking::NonBlocking, WorkerGuard)> {
    if let Err(error) = std::fs::create_dir_all(dir) {
        eprintln!(
            "[logging] could not create log dir {}: {error}",
            dir.display()
        );
        return None;
    }
    let appender = match tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("dimo")
        .filename_suffix("log")
        .max_log_files(14)
        .build(dir)
    {
        Ok(appender) => appender,
        Err(error) => {
            eprintln!(
                "[logging] could not init log appender in {}: {error}",
                dir.display()
            );
            return None;
        }
    };
    Some(tracing_appender::non_blocking(appender))
}

/// Initialize the process-global tracing subscriber with reloadable filter,
/// stderr sink, daily-rotating log file sink, and in-memory live-tail buffer.
pub fn init_logging(desktop: bool, reveal_console: bool) -> WorkerGuard {
    let hub = ensure_hub();
    let initial_filter = match env_level_override() {
        Some(raw) => {
            let directives = if raw.eq_ignore_ascii_case("off") {
                raw
            } else {
                format!("{raw}{FIREHOSE_BACKSTOPS}")
            };
            EnvFilter::builder().parse_lossy(directives)
        }
        None if reveal_console => EnvFilter::new("error"),
        None => build_env_filter(&load_persisted_settings()),
    };
    let (filter_layer, reload_handle) = reload::Layer::new(initial_filter);
    *hub.reload.write().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(move |next_filter| {
        reload_handle
            .reload(next_filter)
            .map_err(|error| error.to_string())
    }));

    let logs_dir = utils::assets::logs_dir();
    let file = init_file_writer(&logs_dir);

    let guard = match file {
        Some((non_blocking, guard)) => {
            if desktop {
                // Keep stdout clean for the single-line ready JSON handshake.
                let _ = Registry::default()
                    .with(filter_layer)
                    .with(fmt::layer().with_writer(std::io::stderr))
                    .with(BufferEmitLayer)
                    .with(fmt::layer().with_ansi(false).with_writer(non_blocking))
                    .try_init();
            } else {
                let _ = Registry::default()
                    .with(filter_layer)
                    .with(fmt::layer().without_time())
                    .with(BufferEmitLayer)
                    .with(fmt::layer().with_ansi(false).with_writer(non_blocking))
                    .try_init();
            }
            guard
        }
        None => {
            if desktop {
                let _ = Registry::default()
                    .with(filter_layer)
                    .with(fmt::layer().with_writer(std::io::stderr))
                    .with(BufferEmitLayer)
                    .try_init();
            } else {
                let _ = Registry::default()
                    .with(filter_layer)
                    .with(fmt::layer().without_time())
                    .with(BufferEmitLayer)
                    .try_init();
            }
            let (_writer, guard) = tracing_appender::non_blocking(std::io::sink());
            guard
        }
    };

    tracing::info!("logging initialized; log dir = {}", logs_dir.display());
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record(seq: u64, message: &str) -> LogRecord {
        LogRecord {
            seq,
            timestamp_ms: 1_700_000_000_000,
            level: "INFO",
            target: "server".into(),
            message: message.into(),
            fields: BTreeMap::new(),
        }
    }

    #[test]
    fn valid_targets_reject_logging_recursion() {
        assert!(is_valid_target("agents"));
        assert!(is_valid_target("server::ws"));
        assert!(!is_valid_target(""));
        assert!(!is_valid_target("dimo::logging"));
        assert!(!is_valid_target("server::desktop::logging"));
    }

    #[test]
    fn ring_buffer_caps_count_and_returns_newest_slice() {
        let mut buf = RingBuffer::new();
        let total = (LOG_BUFFER_MAX_COUNT + 10) as u64;
        for seq in 0..total {
            buf.push(sample_record(seq, "msg"));
        }
        let recent = buf.recent(5);
        assert_eq!(recent.len(), 5);
        assert_eq!(recent.first().unwrap().seq, total - 5);
        assert_eq!(recent.last().unwrap().seq, total - 1);
    }

    #[test]
    fn live_tail_emit_stays_silent_until_recent_logs_is_requested() {
        let hub = LogHub::new();
        let bus = Arc::new(crate::HostEventBus::new());
        let mut rx = bus.subscribe();
        hub.attach_bus(bus);

        hub.record_and_emit(sample_record(1, "before-viewer"));
        assert!(
            rx.try_recv().is_err(),
            "general HostEventBus subscribers must not receive log bursts before a log viewer opens"
        );

        let recent = hub.recent_logs(10);
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].seq, 1);

        hub.record_and_emit(sample_record(2, "after-viewer"));
        let event = rx
            .try_recv()
            .expect("live tail emits logs://appended once recent_logs activates the viewer");
        assert_eq!(event.channel, LOG_APPENDED_EVENT);
        assert_eq!(event.payload["seq"], 2);
        assert_eq!(event.payload["message"], "after-viewer");
    }
}
