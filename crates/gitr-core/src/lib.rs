pub mod branches;
pub mod diff;
pub mod discovery;
pub mod error;
pub mod hooks;
pub mod highlight;
pub mod info;
#[cfg(windows)]
mod job;
pub mod locate;
pub mod log;
pub mod pathbytes;
pub mod redact;
pub mod repo;
pub mod runner;
pub mod status;

pub use error::GitError;
pub use repo::Git;
pub use runner::GitRunner;
