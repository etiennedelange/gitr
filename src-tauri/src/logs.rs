//! Log files: daily rolling files in `%APPDATA%\gitr\logs`, 14 kept, level from `GITR_LOG`.

use std::path::Path;

use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer, fmt};

pub const PREFIX: &str = "gitr";
pub const SUFFIX: &str = "log";
pub const MAX_FILES: usize = 14;
pub const LEVEL_ENV: &str = "GITR_LOG";

/// Installs the global subscriber and the panic hook. Safe to call once at startup; logging
/// problems never prevent the app from starting.
pub fn init(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);

    let filter = EnvFilter::try_from_env(LEVEL_ENV).unwrap_or_else(|_| EnvFilter::new("info"));
    // The appender writes synchronously (no background worker), so nothing is lost when the
    // process dies right after a panic.
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(PREFIX)
        .filename_suffix(SUFFIX)
        .max_log_files(MAX_FILES)
        .build(dir)
        .ok()
        .map(|appender| fmt::layer().with_ansi(false).with_writer(appender).boxed());
    let stderr = cfg!(debug_assertions).then(|| fmt::layer().with_writer(std::io::stderr).boxed());
    // After the appender has created today's file, so at most MAX_FILES remain including it.
    prune(dir, MAX_FILES);

    let _ = tracing_subscriber::registry().with(filter).with(file).with(stderr).try_init();
    install_panic_hook();
    tracing::debug!(target: "gitr", dir = %dir.display(), level_env = LEVEL_ENV, "logging initialised");
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!(target: "gitr::panic", panic = %info, %backtrace, "panic");
        previous(info);
    }));
}

/// Deletes all but the newest `keep` log files. tracing-appender only prunes when it rotates,
/// so do it at startup as well.
pub fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut logs: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.starts_with(&format!("{PREFIX}.")) && n.ends_with(&format!(".{SUFFIX}"))
            })
        })
        .collect();
    // Names carry the date (gitr.YYYY-MM-DD.log), so name order is age order.
    logs.sort();
    let excess = logs.len().saturating_sub(keep);
    for old in logs.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_newest_files_only() {
        let tmp = tempfile::tempdir().unwrap();
        for day in 1..=20 {
            std::fs::write(tmp.path().join(format!("gitr.2026-01-{day:02}.log")), "x").unwrap();
        }
        std::fs::write(tmp.path().join("config.toml"), "x").unwrap();
        prune(tmp.path(), 14);
        let mut left: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left.len(), 15);
        assert_eq!(left.first().unwrap(), "config.toml");
        assert_eq!(left[1], "gitr.2026-01-07.log");
        assert_eq!(left.last().unwrap(), "gitr.2026-01-20.log");
    }
}
