use thiserror::Error;

#[derive(Clone, Debug, Error)]
#[error("{message}")]
pub struct PortError {
    message: String,
}

impl PortError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}
