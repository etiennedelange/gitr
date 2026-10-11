// `CmdError` carries what the UI needs (message, details, kind, repo, lock file, hook). It is
// built once per failed command and serialized to the UI, so its size costs nothing that matters.
#![allow(clippy::result_large_err)]

mod commands;
mod config;
mod logs;
mod native;
mod ops;
mod recycle;
mod state;
mod update;
mod watcher;

use tauri::{Emitter, Manager};

pub fn run() {
    logs::init(&config::logs_dir());
    tracing::info!(target: "gitr", version = env!("CARGO_PKG_VERSION"), "starting");
    #[cfg(debug_assertions)]
    if std::env::var_os("GITR_TEST_PANIC").is_some() {
        // Manual check that panics reach the log file (debug builds only).
        let _ = std::thread::spawn(|| panic!("GITR_TEST_PANIC requested")).join();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::AppState::load())
        .manage(watcher::FocusGate::default())
        .setup(|app| {
            let zoom = app.state::<state::AppState>().config().zoom;
            if let Some(window) = app.get_webview_window("main") {
                native::harden(&window);
                let _ = window.set_zoom(zoom as f64 / 100.0);
            }
            app.manage(state::repo_ops(app.handle()));
            // `pnpm mock` points the window at the mock UI (preview.html), which answers every
            // Gitr command itself. Keep the backend idle then: no watcher on real repositories.
            let mock = cfg!(debug_assertions)
                && app.config().build.dev_url.as_ref().is_some_and(|u| u.path().ends_with("/preview.html"));
            if mock {
                tracing::info!(target: "gitr", "mock UI: backend idle, watcher not started");
            } else {
                commands::restart_watcher(app.handle());
            }
            let git = app.state::<state::AppState>().git.clone();
            tauri::async_runtime::spawn(async move {
                let version = git.runner().version().await;
                tracing::info!(target: "gitr", git = %version, "git version");
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                let ops = app.state::<ops::RepoOps>();
                for repo in app.state::<watcher::FocusGate>().set_focused(*focused) {
                    ops.request_refresh(&repo);
                }
                if *focused {
                    // The UI refreshes the open repo too, in case the watcher missed something.
                    let _ = app.emit("window-focused", ());
                }
            }
            // Killing git halfway through a commit, checkout or rebase can leave index.lock or a
            // half-updated worktree, so a close request waits for running writes to finish.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let ops = window.app_handle().state::<ops::RepoOps>().inner().clone();
                if ops.writes_running() {
                    api.prevent_close();
                    let window = window.clone();
                    let title = window.title().unwrap_or_else(|_| "Gitr".into());
                    let _ = window.set_title("Gitr - finishing before closing…");
                    tauri::async_runtime::spawn(async move {
                        ops.writes_finished(ops::WRITES_LIMIT).await;
                        let _ = window.set_title(&title);
                        let _ = window.destroy();
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::set_zoom,
            commands::open_devtools,
            commands::open_logs_folder,
            commands::git_info,
            commands::set_git_path,
            commands::recheck_git,
            commands::remove_stale_lock,
            commands::trust_folder,
            commands::abort_operation,
            commands::pull_strategy,
            commands::divergence,
            commands::integrate,
            commands::continue_operation,
            commands::skip_operation,
            commands::log,
            commands::commit_details,
            commands::commit_file_diff,
            commands::reset_preview,
            commands::revert_commit,
            commands::reset_branch,
            commands::undo_reset,
            commands::merge_message,
            commands::devtools_available,
            commands::list_repos,
            commands::rescan_repos,
            commands::refresh_all,
            commands::repo_summary,
            commands::run_batch,
            commands::busy_repos,
            commands::repo_status,
            commands::line_stats,
            commands::stage,
            commands::unstage,
            commands::discard,
            commands::file_diff,
            commands::commit,
            commands::last_commit_undo,
            commands::undo_last_commit,
            commands::last_commit_message,
            commands::push,
            commands::branches,
            commands::checkout,
            commands::create_branch,
            commands::delete_branch,
            commands::open_remote,
            commands::open_with,
            commands::generate_commit_message,
            commands::cancel_generation,
            commands::cancel_operation,
            commands::refresh_repo,
            commands::list_models,
            update::app_version,
            update::check_update,
            update::install_update,
            update::open_release_page,
        ])
        .build(context())
        .expect("error while building Gitr")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let ai = app.state::<state::AppState>().ai.clone();
                tauri::async_runtime::block_on(ai.shutdown());
            }
        });
}

/// The Tauri context. Debug builds only: `GITR_E2E_DEVTOOLS_PORT` opens the WebView2 DevTools
/// protocol on that port, so `tools/e2e` can drive the real app. (WebView2 ignores
/// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS because wry always passes its own arguments.)
fn context() -> tauri::Context<tauri::Wry> {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if let Ok(port) = std::env::var("GITR_E2E_DEVTOOLS_PORT")
        && port.parse::<u16>().is_ok()
    {
        for window in &mut context.config_mut().app.windows {
            // wry's defaults, plus the debugging port.
            window.additional_browser_args = Some(format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
            ));
        }
    }
    // Debug builds only: load the UI from the given dev server instead of the configured one, so
    // an end-to-end run uses its own checkout's UI (port 5173 may belong to another worktree).
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("GITR_E2E_DEV_URL")
        && let Ok(url) = url.parse::<tauri::Url>()
    {
        context.config_mut().build.dev_url = Some(url);
    }
    context
}
