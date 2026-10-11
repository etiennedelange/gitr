# End-to-end checks (real app)

These scripts drive the **real** Gitr debug build: the real Rust backend, real git on throwaway repos, the real React UI and the real native Windows dialogs.

```powershell
cargo build -p gitr
node tools/e2e/actionable-errors.mjs
node tools/e2e/diverged-pull.mjs
node tools/e2e/close-during-commit.mjs
node tools/e2e/discard-and-undo.mjs
node tools/e2e/branches-and-push.mjs
node tools/e2e/external-changes.mjs
node tools/e2e/odd-files.mjs
node tools/e2e/dashboard-batch.mjs
node tools/e2e/generate-without-copilot.mjs
node tools/e2e/settings-flow.mjs
node tools/e2e/conflict-states.mjs
node tools/e2e/unusual-repos.mjs
node tools/e2e/hooks.mjs
node tools/e2e/many-files-ui.mjs   # slow; FILES=6000 by default
REPOS="D:path;D:pathb" node tools/e2e/real-repos-readonly.mjs   # your own repos, strictly read-only
```

## How it works

- **Throwaway setup.** The script creates scenario repos and an app config under `%TEMP%\gitr-e2e-*`, then starts `target\debug\gitr.exe` with:
  - its own `APPDATA`, so it doesn't touch your settings;
  - its own WebView2 profile;
  - `GITR_E2E_DEVTOOLS_PORT`.
- **DevTools port.** `GITR_E2E_DEVTOOLS_PORT` exists in **debug builds only**. It opens WebView2's DevTools protocol on that port (see `context()` in `src-tauri/src/lib.rs`). WebView2 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, because wry always passes its own arguments.
- **`cdp.mjs`** connects over the DevTools protocol using Node's built-in WebSocket, with no dependencies. It clicks buttons, reads the screen and takes screenshots.
- **`dialog.ps1`** answers native dialogs through Windows UI Automation, and returns the dialog's text so the script can check it. It never uses simulated keystrokes, which would go to whatever window has focus on a desktop in use. Task-dialog buttons are pressed with `TDM_CLICK_BUTTON`, sent to that dialog's own window.
- **Dev server.** Each script starts **its own** Vite server from this checkout on its own port (5290, 5291, …), and points the app at it with `GITR_E2E_DEV_URL` (debug builds only). Port 5173 may belong to another worktree's `pnpm dev`, so the scripts check `location.port` and fail if the app didn't load this checkout's UI.
- **Output.** Results print as PASS/FAIL lines, and screenshots are saved in the run's `shots` folder.
