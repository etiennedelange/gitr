//! In-app updates for the direct download (NSIS installer from GitHub Releases).
//!
//! The Microsoft Store build runs inside an MSIX package and is updated by the Store, so there
//! every command here answers `channel: "store"` straight away and touches no network.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::ops::{self, RepoOps};
use crate::state::{AppState, CmdError};

const RELEASES: &str = "https://github.com/etiennedelange/gitr/releases";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    /// Installed with the `-setup.exe` from GitHub Releases; updates itself.
    Direct,
    /// Installed from the Microsoft Store, which updates it.
    Store,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    pub version: String,
    pub channel: Channel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// The release's CHANGELOG section.
    pub notes: Option<String>,
    /// RFC 3339, as published in latest.json.
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub channel: Channel,
    pub available: Option<UpdateInfo>,
}

/// Whether Gitr runs inside an MSIX package (the Microsoft Store build).
#[cfg(windows)]
pub fn packaged() -> bool {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(|| {
        let mut len = 0u32;
        // SAFETY: with no buffer the call only reports the name's length (or that there is no package).
        let rc = unsafe { GetCurrentPackageFullName(&mut len, None) };
        rc != APPMODEL_ERROR_NO_PACKAGE
    })
}

#[cfg(not(windows))]
pub fn packaged() -> bool {
    false
}

fn channel() -> Channel {
    if packaged() { Channel::Store } else { Channel::Direct }
}

/// The running version and where its updates come from. No network.
#[tauri::command]
pub fn app_version(app: AppHandle) -> AppVersion {
    AppVersion { version: app.package_info().version.to_string(), channel: channel() }
}

/// Asks GitHub Releases (latest.json) whether a newer version exists. A failure is logged and
/// returned; the UI only shows it when the user asked (Settings → Check for updates).
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateCheck, CmdError> {
    if packaged() {
        return Ok(UpdateCheck { channel: Channel::Store, available: None });
    }
    let found = async { app.updater()?.check().await }.await.map_err(|e| {
        tracing::warn!(target: "gitr", error = %e, "update check failed");
        CmdError::msg(format!("Couldn't check for updates: {e}"))
    })?;
    if let Some(update) = &found {
        tracing::info!(target: "gitr", version = %update.version, "update available");
    }
    Ok(UpdateCheck {
        channel: Channel::Direct,
        available: found.map(|u| UpdateInfo {
            date: u.raw_json.get("pub_date").and_then(|d| d.as_str()).map(str::to_owned),
            version: u.version,
            notes: u.body,
        }),
    })
}

/// Downloads the update, waits for running git writes, then runs the installer. On Windows the
/// installer runs in passive mode, this process exits, and the installer restarts Gitr.
#[tauri::command]
pub async fn install_update(app: AppHandle, ops: State<'_, RepoOps>, state: State<'_, AppState>) -> Result<(), CmdError> {
    if packaged() {
        return Err(CmdError::msg("Updates come from the Microsoft Store."));
    }
    let failed = |e: tauri_plugin_updater::Error| {
        tracing::warn!(target: "gitr", error = %e, "update failed");
        CmdError::msg(format!("Couldn't update Gitr: {e}"))
    };
    let update = app.updater().map_err(failed)?.check().await.map_err(failed)?;
    let Some(update) = update else {
        return Err(CmdError::msg("Gitr is already up to date."));
    };
    tracing::info!(target: "gitr", version = %update.version, "downloading update");
    let bytes = update.download(|_, _| {}, || {}).await.map_err(failed)?;
    // Exiting halfway through a commit, checkout or rebase can leave index.lock or a
    // half-updated worktree (as when closing the window).
    if !ops.writes_finished(ops::WRITES_LIMIT).await {
        return Err(CmdError::msg("A git operation is still running. Update when it has finished."));
    }
    // The installer exits this process without Tauri's exit event; stop Copilot first.
    state.ai.shutdown().await;
    tracing::info!(target: "gitr", version = %update.version, "installing update");
    update.install(bytes).map_err(failed)?;
    // Only reached off Windows, where the new version is in place but not running yet.
    app.restart();
}

/// Opens the GitHub release page of `version`.
#[tauri::command]
pub fn open_release_page(app: AppHandle, version: String) -> Result<(), CmdError> {
    let url = release_page(&version).ok_or_else(|| CmdError::msg(format!("\"{version}\" is not a version")))?;
    app.opener().open_url(url, None::<&str>).map_err(|e| CmdError::msg(e.to_string()))
}

fn release_page(version: &str) -> Option<String> {
    let valid = !version.is_empty() && version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    valid.then(|| format!("{RELEASES}/tag/v{version}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_page_takes_only_version_characters() {
        assert_eq!(release_page("0.3.0").as_deref(), Some("https://github.com/etiennedelange/gitr/releases/tag/v0.3.0"));
        assert_eq!(release_page("1.0.0-beta.1").as_deref(), Some("https://github.com/etiennedelange/gitr/releases/tag/v1.0.0-beta.1"));
        assert_eq!(release_page(""), None);
        assert_eq!(release_page("1.0/../../evil"), None);
        assert_eq!(release_page("1.0?x=y"), None);
    }

    #[test]
    fn the_store_channel_serializes_as_the_ui_expects() {
        let check = UpdateCheck { channel: Channel::Store, available: None };
        assert_eq!(serde_json::to_string(&check).unwrap(), r#"{"channel":"store","available":null}"#);
    }
}
