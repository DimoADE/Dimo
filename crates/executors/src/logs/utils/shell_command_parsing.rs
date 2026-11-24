//! Shell command parsing utilities for categorizing commands

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Category of a shell command, used for display grouping and filtering
#[derive(Debug, Clone, Serialize, Deserialize, TS, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandCategory {
    /// Commands that read files (cat, head, tail, ls, etc.)
    Read,
    /// Commands that search for content (grep, rg, find, etc.)
    Search,
    /// Commands that modify files or state (sed, awk, cp, mv, etc.)
    Edit,
    /// Commands that fetch remote content (curl, wget, etc.)
    Fetch,
    /// Everything else
    #[default]
    Other,
}
