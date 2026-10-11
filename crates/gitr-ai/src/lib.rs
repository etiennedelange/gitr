mod copilot;
mod prompt;

pub use copilot::{CopilotGenerator, find_copilot_cli};
pub use prompt::{CommitPrompt, build_prompt, clean_output, extract_ticket};

use async_trait::async_trait;

#[derive(Debug, Clone, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AiError {
    #[error("Copilot CLI not found. Install it (winget install GitHub.Copilot) and run `copilot` once to sign in.")]
    CliNotFound,
    #[error("Nothing is staged")]
    NothingStaged,
    #[error("Copilot returned an empty message")]
    Empty,
    #[error("Copilot request timed out")]
    Timeout,
    #[error("Copilot error: {0}")]
    Sdk(String),
}

pub type DeltaFn = Box<dyn Fn(&str) + Send + Sync>;

#[async_trait]
pub trait MessageGenerator: Send + Sync {
    async fn generate(&self, prompt: CommitPrompt, on_delta: DeltaFn) -> Result<String, AiError>;
}
