use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use github_copilot_sdk::handler::DenyAllHandler;
use github_copilot_sdk::types::{MessageOptions, SessionConfig, SystemMessageConfig};
use github_copilot_sdk::{Client, ClientOptions};
use tokio::sync::OnceCell;

use crate::{AiError, CommitPrompt, DeltaFn, MessageGenerator, clean_output};

const TIMEOUT: Duration = Duration::from_secs(90);

/// Generates commit messages through the Copilot CLI (billed to the user's Copilot seat).
/// The CLI process is started lazily and reused across requests.
pub struct CopilotGenerator {
    cli_path: Option<PathBuf>,
    model: std::sync::RwLock<Option<String>>,
    client: OnceCell<Client>,
}

impl CopilotGenerator {
    pub fn new(cli_path: Option<PathBuf>, model: Option<String>) -> Self {
        Self { cli_path, model: std::sync::RwLock::new(model), client: OnceCell::new() }
    }

    async fn client(&self) -> Result<&Client, AiError> {
        self.client
            .get_or_try_init(|| async {
                let path = self.cli_path.clone().or_else(find_copilot_cli).ok_or(AiError::CliNotFound)?;
                let mut opts = ClientOptions::default().with_program(path);
                opts.working_directory = std::env::temp_dir();
                Client::start(opts).await.map_err(|e| AiError::Sdk(e.to_string()))
            })
            .await
    }

    pub fn set_model(&self, model: Option<String>) {
        *self.model.write().unwrap() = model;
    }

    /// Returns (id, display name) pairs of models available to the signed-in user.
    pub async fn list_models(&self) -> Result<Vec<(String, String)>, AiError> {
        let models = self.client().await?.list_models().await.map_err(|e| AiError::Sdk(e.to_string()))?;
        Ok(models.into_iter().map(|m| (m.id, m.name)).collect())
    }

    pub async fn shutdown(&self) {
        if let Some(c) = self.client.get() {
            let _ = c.stop().await;
        }
    }
}

#[async_trait]
impl MessageGenerator for CopilotGenerator {
    async fn generate(&self, prompt: CommitPrompt, on_delta: DeltaFn) -> Result<String, AiError> {
        let client = self.client().await?;

        let mut config = SessionConfig::default()
            .with_permission_handler(Arc::new(DenyAllHandler))
            .with_streaming(true)
            .with_system_message(
                SystemMessageConfig::new().with_mode("replace").with_content(prompt.system),
            )
            .with_available_tools(Vec::<String>::new())
            .with_working_directory(std::env::temp_dir());
        if let Some(m) = self.model.read().unwrap().clone() {
            config = config.with_model(m);
        }

        let session = client
            .create_session(config)
            .await
            .map_err(|e| AiError::Sdk(e.to_string()))?;

        let streamed = Arc::new(std::sync::Mutex::new(String::new()));
        let mut events = session.subscribe();
        let acc = streamed.clone();
        // The session keeps the event sender alive, so this task must be aborted, not awaited.
        let streamer = tokio::spawn(async move {
            while let Ok(ev) = events.recv().await {
                if ev.event_type == "assistant.message_delta"
                    && let Some(d) = ev.data.get("deltaContent").and_then(|v| v.as_str()) {
                        acc.lock().unwrap().push_str(d);
                        on_delta(d);
                    }
            }
        });

        let result = session
            .send_and_wait(MessageOptions::new(prompt.user).with_wait_timeout(TIMEOUT))
            .await;
        streamer.abort();
        let session_id = session.id().clone();
        let _ = session.disconnect().await;
        // Commit-message sessions are throwaway; don't leave them in the user's session history.
        let _ = client.delete_session(&session_id).await;
        let streamed = streamed.lock().unwrap().clone();

        let final_event = result.map_err(|e| {
            let msg = e.to_string();
            if msg.to_ascii_lowercase().contains("timeout") || msg.contains("timed out") {
                AiError::Timeout
            } else {
                AiError::Sdk(msg)
            }
        })?;
        let content = final_event
            .and_then(|ev| ev.data.get("content").and_then(|v| v.as_str()).map(str::to_string))
            .unwrap_or(streamed);
        let message = clean_output(&content);
        if message.is_empty() {
            return Err(AiError::Empty);
        }
        Ok(message)
    }
}

/// Locates `copilot` via `COPILOT_CLI_PATH` or PATH (the SDK itself does not scan PATH).
/// Prefers real binaries over Windows App Execution Alias stubs in `WindowsApps`.
pub fn find_copilot_cli() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("COPILOT_CLI_PATH").map(PathBuf::from)
        && p.is_file() {
            return Some(p);
        }
    let names: &[&str] = if cfg!(windows) { &["copilot.exe", "copilot.cmd"] } else { &["copilot"] };
    let path = std::env::var_os("PATH")?;
    let mut candidates: Vec<PathBuf> = std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .filter(|p| p.is_file())
        .collect();
    candidates.sort_by_key(|p| p.to_string_lossy().contains("WindowsApps"));
    candidates.into_iter().next()
}
