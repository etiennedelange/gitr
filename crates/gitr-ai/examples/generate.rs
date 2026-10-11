//! Live smoke test: cargo run -p gitr-ai --example generate -- <repo-with-staged-changes>
use gitr_ai::{CopilotGenerator, MessageGenerator, build_prompt};
use gitr_core::Git;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("github_copilot_sdk=info")
        .with_writer(std::io::stderr)
        .init();
    let repo = std::env::args().nth(1).expect("repo path");
    let changes = Git::default().staged_changes(repo.as_ref(), 60_000).await.unwrap();
    let generator = CopilotGenerator::new(None, None);
    let started = std::time::Instant::now();
    let msg = generator
        .generate(build_prompt(&changes), Box::new(|d| eprint!("{d}")))
        .await;
    println!("\n--- {:?}\n{msg:?}", started.elapsed());
    generator.shutdown().await;
}
