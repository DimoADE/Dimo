//! Verified HTTPS downloader for managed tool and runtime distributions.

mod adapters;
mod error;
mod ports;
mod types;

pub use adapters::{HostResolver, HttpDownloader, SystemHostResolver};
pub use error::PortError;
pub use ports::Downloader;
pub use types::validate_distribution_url;
