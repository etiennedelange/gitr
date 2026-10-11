---
name: verify
description: Run the real Gitr app (Rust backend + React UI) headless in the Linux dev container and drive it over WebDriver, to verify a change at its real surface. Use for /verify or "check it works in the app".
---

# Verify Gitr in the dev container

The `tools/e2e` scripts are Windows-only (WebView2 DevTools + UI Automation). In the Linux dev
container, drive the real debug build under Xvfb with `tauri-driver` + WebKitWebDriver instead.
The browser mock (`pnpm mock:web`) is not evidence for backend changes: its backend is fake.

## One-time setup

```bash
sudo apt-get install -y webkit2gtk-driver     # WebKitWebDriver; -y or apt aborts
cargo install tauri-driver --locked
```

`xvfb-run` fails (no `xauth`); start Xvfb directly.

## Launch

```bash
cargo build -p gitr
(cd ui && pnpm exec vp dev --port 5390 --strictPort &)          # own port; 5173 may be the user's
Xvfb :99 -screen 0 1280x800x24 &
DISPLAY=:99 APPDATA=$ROOT/appdata GITR_E2E_DEV_URL=http://127.0.0.1:5390 \
  GIT_CONFIG_GLOBAL=/dev/null tauri-driver &             # WebDriver on 127.0.0.1:4444
```

- `APPDATA` isolates the app: config is `$APPDATA/gitr/config.toml`, e.g.
  `watch = false` plus one `[[groups]]` with `id`, `name`, `roots = ["$ROOT/repos"]`.
  Never let it read the user's real config or workspace.
- `GITR_E2E_DEV_URL` (debug builds) makes the app load this checkout's UI; check
  `location.port` in the page.
- The env given to `tauri-driver` reaches the app and every git it runs.

## Drive

`wd.mjs` (next to this file) is a dependency-free WebDriver client:
`session('/workspaces/gitr/target/debug/gitr')` returns `js()`, `click(regex)` (button text
or aria-label), `text()`, `texts()`, `waitFor()`, `shot(file)`, `quit()`. Each session starts a
fresh app, so re-create the scenario between sessions.

## Fake remotes

For network behaviour without real servers, give scenario repos an `ext::` origin running a
script, with `git config protocol.ext.allow always` in each repo:
`git remote set-url origin "ext::$ROOT/server.sh %s <host> $ROOT/bare/<name>.git"`. The script
can log the environment git hands it (`GCM_INTERACTIVE`, `GIT_SSH_COMMAND`), refuse with
`fatal: Authentication failed for 'https://<host>/'`, or `exec git "$1" "$3"` to serve the bare
repo for real.

## Gotchas

- Native dialogs (`ask`) under Xvfb are untested (no window manager); flows without them are known to work.
- Kill Vite, tauri-driver, WebKitWebDriver, Xvfb and `target/debug/gitr` when done.
- Real Git Credential Manager and Windows-only code (taskkill, WebView2) can't run here.
