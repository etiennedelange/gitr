//! gitr-core's integration tests, as one test binary: cargo runs test binaries one after
//! another, so with one per file each file's tests waited for the file before. Together they run
//! in parallel, and there is one binary to link instead of fourteen.
mod common;

mod errors;
mod hazards;
mod hooks;
mod integrate;
mod large;
mod log;
mod network_env;
mod operations;
mod ops;
#[cfg(unix)]
mod portability;
mod recover;
mod runner;
mod syntax;
