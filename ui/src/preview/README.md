# Design preview (mock data)

Runs the real Gitr UI against a mocked backend, so you can look at every view and state
without real repositories. Nothing here ships in the app.

```
pnpm mock             # repo root: the Gitr window, with mock data
pnpm mock:web         # repo root or ui/: the same in a browser tab (no Rust build needed)
```

Both load `/preview.html`. Edits to components and `src/index.css` hot-reload.

`pnpm mock` is `tauri dev` with `src-tauri/tauri.mock.conf.json`, which only points the
window at `/preview.html`. In the window, Gitr's own commands (repos, status, diff, commit…)
are answered by the mock through `setInvoke` in `src/api.ts`. Tauri plugin calls still reach the
real app: events, confirmation dialogs and the title bar following the theme.

The backend process still starts, but it sees the mock address and stays idle. It starts no file
watcher (the log says "mock UI: backend idle"), and the UI never sends it a Gitr command, so
your real repositories are neither read nor changed. It still reads its own settings file at
startup, for the window zoom.

`pnpm mock` needs port 5173, like `pnpm dev`. Stop `pnpm mock:web` first if it is running.

## Toolbar

A dark **Mock** button in the bottom-right corner (it is not part of the app). Click it to open:

- **Scenario**: switches the mock data set and reloads.
- **Hooks**: what Commit and Push do. *Hooks pass (slow)* prints lint or test output for a few
  seconds (try Stop), *Hooks fail* ends with a rejection (try **Commit without hooks**).
- **Sign-in**: *Sign-in expired* makes Fetch all and Pull all report "Sign-in needed"; the
  dashboard's **Sign in** then asks once per server (a stand-in for Git Credential Manager). A
  server is a host plus owner: fleet-api and data-pipeline are in a second Azure DevOps
  organisation (`contoso`), so dev.azure.com is asked twice. data-pipeline is still refused after
  signing in (a 403), so the summary shows a failure that no sign-in fixes. Answer No to see a
  failed sign-in.
- **Light / Dark**: flips the theme.
- **Toast / Error toast**: shows a sample notification.
- **Hide toolbar**: hides it until the next reload.

Confirmation dialogs appear as the browser's own confirm box in `pnpm mock:web`.

The mock backend is live. Staging, unstaging and committing change the data until you reload.
Nothing touches disk.

In-progress operations are live too: staging a conflicted file resolves it, and once none is
left **Continue** is enabled. A rebase stops on one more conflict after its first Continue or
Skip; the next one finishes it. **Abort** and **End bisect** end the operation.

billing-service has an untracked folder (`tools/invoice-cli/`). As in the app, the dashboard
counts it as one change while the Changes list and its tab show each file.
Actions the preview does not implement reject explicitly rather than pretending to succeed;
use the isolated Git tests or the real-app E2E scripts for those operations.

## Scenarios

| id        | What it shows |
|-----------|---------------|
| `default` | 12 repos in 2 groups. billing-service has staged and unstaged files, an untracked folder, line counts and a diff; identity-server is merging with a conflicted file. |
| `many`    | 29 repos in 3 groups, every status, all five dot sizes (0, 1–2, 3–9, 10–29, 30+ changes), long repo and group names, two busy repos, and `gateway` with a 152-file change list. |
| `errors`  | Sign-in, lock and ownership errors, far behind, and every operation that can stop half-way: merge (fleet-api), rebase (reporting, detached), cherry-pick (identity-server), revert with conflicts resolved (notifications), bisect (gitr), `git am` (dotfiles). Their banners show Continue, Skip, Abort or End bisect. |
| `clean`   | Nothing to commit anywhere: empty lists and the clean state. |
| `empty`   | First run with no groups, so the app opens Settings. |

## URL parameters

Useful for bookmarks and for scripted screenshots. All of them are optional.

| parameter | values |
|-----------|--------|
| `scenario` | `default`, `many`, `errors`, `clean`, `empty` |
| `theme` | `light`, `dark` (remembered, like the in-app setting) |
| `view` | `repo`, `settings` (default: dashboard) |
| `repo` | repo name, e.g. `billing-service` (default: the first repo with a change list) |
| `tab` | `history`, `branches` |
| `file` | end of a file path to select, e.g. `InvoiceExporter.cs` |
| `message` | text to put in the commit box, e.g. `Fix rounding` |
| `git` | `missing`, `old`: shows the git banner |
| `toast` | `non-fast-forward`, `lock`, `dubious-ownership`, `auth`: shows that error with its fix buttons |
| `generate` | `error`: reject commit-message generation to test that an existing draft survives |
| `hooks` | `pass`, `fail`: Commit and Push run simulated hooks that print output for a few seconds, then pass or fail (also in the toolbar's Hooks menu). Try Stop while they run, or **Commit without hooks** after a failure |
| `signin` | `expired`: Fetch all and Pull all need a sign-in (also in the toolbar's Sign-in menu) |
| `update` | `available`: version 0.3.0 is out, so the update banner appears 5 seconds after load and Settings → Updates offers it (**Restart and update** shows Updating… and then fails, as the preview installs nothing). `error`: the check fails (quiet at startup; Settings shows the error). `store`: the Microsoft Store build, with no banner and "Updates come from the Microsoft Store." in Settings. Without it, Gitr is up to date |
| `history` | `slow`, `error`: the History tab stays loading, or fails to read the history |
| `revert` | `conflict`: Revert in History stops on a conflict and the repo enters the Reverting state |
| `chrome` | `0` hides the toolbar |

History data is generated per repo from a seed (`history.ts`): billing-service has more than 200 commits so the list pages, every repo has merges, tags and a root commit, and notifications has no commits yet. Commit, Push, Revert, Reset and Undo reset change it for the rest of the session.

Example: `/preview.html?scenario=many&theme=dark&view=repo&repo=gateway`

Headless screenshot (Chrome):

```
chrome --headless=new --window-size=1400,900 --virtual-time-budget=4000 \
  --screenshot=out.png "http://127.0.0.1:5173/preview.html?chrome=0&scenario=many"
```

## Adding data

Scenarios live in `scenarios.ts`. The default data set is in `data.ts`.

To add a scenario:
1. Write a function that returns a `Scenario`: groups, repos, summaries, and optionally per-repo status, line counts, diffs, branches and busy repos.
2. Add it to `SCENARIOS`. It then appears in the toolbar.

`bigTree(n)` generates a change list of `n` files with line counts.
