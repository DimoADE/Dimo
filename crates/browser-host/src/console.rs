//! Per-tab ring of what the page printed to its console.
//!
//! Captured per tab, cleared on navigation, and filtered to the tab's active
//! origin when read so cross-origin subframes never leak into an agent's read
//! of the top-level page.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

pub const MAX_ENTRIES: usize = 200;
pub const MAX_ENTRY_CHARS: usize = 2_000;
pub const MAX_RING_CHARS: usize = 100_000;
pub const DEFAULT_READ_LIMIT: usize = 100;
pub const MAX_READ_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ConsoleLevel {
    Debug,
    #[default]
    Log,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => Some(Self::Debug),
            "log" | "dir" | "dirxml" | "table" | "count" | "timeend" => Some(Self::Log),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" | "assert" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Log => "log",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ConsoleSource {
    #[default]
    Console,
    Error,
    UnhandledRejection,
}

impl ConsoleSource {
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "error" => Self::Error,
            "unhandled-rejection" | "unhandledRejection" => Self::UnhandledRejection,
            _ => Self::Console,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub seq: u64,
    pub level: ConsoleLevel,
    pub source: ConsoleSource,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub at: i64,
    pub top: bool,
    #[serde(skip)]
    pub frame_origin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLine {
    pub level: ConsoleLevel,
    #[serde(default)]
    pub source: ConsoleSource,
    pub text: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    pub at: i64,
    #[serde(default = "default_top")]
    pub top: bool,
    #[serde(default)]
    pub frame_origin: Option<String>,
}

fn default_top() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleQuery {
    #[serde(default)]
    pub since: u64,
    #[serde(default)]
    pub min_level: Option<ConsoleLevel>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleRead {
    pub url: String,
    pub entries: Vec<ConsoleEntry>,
    pub dropped: u64,
    pub next_since: u64,
    pub more: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ConsoleRing {
    entries: VecDeque<ConsoleEntry>,
    chars: usize,
    next_seq: u64,
    dropped: u64,
}

impl ConsoleRing {
    pub fn clear(&mut self) {
        self.entries.clear();
        self.chars = 0;
        self.dropped = 0;
    }

    pub fn push(&mut self, line: ConsoleLine) -> u64 {
        let (text, clipped) = cap_chars(&line.text, MAX_ENTRY_CHARS);
        if clipped {
            self.dropped = self.dropped.saturating_add(1);
        }
        let weight = text.chars().count();
        self.next_seq = self.next_seq.saturating_add(1);
        let seq = self.next_seq;
        let url = line
            .url
            .filter(|u| !u.is_empty())
            .map(|u| cap_chars(&u, 512).0);
        self.entries.push_back(ConsoleEntry {
            seq,
            level: line.level,
            source: line.source,
            text,
            url,
            line: line.line,
            column: line.column,
            at: line.at,
            top: line.top,
            frame_origin: line.frame_origin,
        });
        self.chars = self.chars.saturating_add(weight);
        while self.entries.len() > MAX_ENTRIES
            || (self.chars > MAX_RING_CHARS && self.entries.len() > 1)
        {
            if let Some(old) = self.entries.pop_front() {
                self.chars = self.chars.saturating_sub(old.text.chars().count());
                self.dropped = self.dropped.saturating_add(1);
            }
        }
        seq
    }

    pub fn read(&self, url: &str, origin: &str, query: &ConsoleQuery) -> ConsoleRead {
        let min = query.min_level.unwrap_or(ConsoleLevel::Debug);
        let limit = query
            .limit
            .unwrap_or(DEFAULT_READ_LIMIT)
            .clamp(1, MAX_READ_LIMIT);
        let mut matching = self.entries.iter().filter(|e| {
            e.seq > query.since
                && e.level >= min
                && (e.top || e.frame_origin.as_deref() == Some(origin))
        });
        let entries: Vec<ConsoleEntry> = matching.by_ref().take(limit).cloned().collect();
        let more = matching.next().is_some();
        let next_since = if more {
            entries.last().map(|e| e.seq).unwrap_or(query.since)
        } else {
            self.next_seq.max(query.since)
        };
        ConsoleRead {
            url: url.to_string(),
            entries,
            dropped: self.dropped,
            next_since,
            more,
        }
    }
}

fn cap_chars(raw: &str, max: usize) -> (String, bool) {
    let mut chars = raw.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        (format!("{head}…"), true)
    } else {
        (raw.to_string(), false)
    }
}
