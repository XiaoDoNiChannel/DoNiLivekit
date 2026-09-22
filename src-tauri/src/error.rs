use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub(crate) enum AudioError {
    InvalidInput(String),
    StatePoisoned(&'static str),
    Transport(String),
}

impl Display for AudioError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::Transport(message) => formatter.write_str(message),
            Self::StatePoisoned(name) => write!(formatter, "状态锁被污染: {name}"),
        }
    }
}

impl std::error::Error for AudioError {}

impl From<AudioError> for String {
    fn from(error: AudioError) -> Self {
        error.to_string()
    }
}
