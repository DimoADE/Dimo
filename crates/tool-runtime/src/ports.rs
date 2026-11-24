use async_trait::async_trait;

use crate::PortError;

#[async_trait]
pub trait Downloader: Send + Sync {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, PortError>;
}
