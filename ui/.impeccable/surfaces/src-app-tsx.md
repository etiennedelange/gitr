---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

# Gitr app shell (dashboard, repo view, settings)

Scope: the whole desktop app UI. Mode: Operate. Audience and product truth: see PRODUCT.md.
Confirmed answers (2026-10-11): accent need not be Windows blue; attention-first dashboard; leave work uncommitted. 2026-10-19: type changed from Hanken Grotesk and Cascadia Mono to the brand's IBM Plex Sans and JetBrains Mono, bundled, body 14px.
Direction pinned by the user's brief (native-feeling developer tool, restrained neutrals, one accent, dense and readable); no concept roll was run.

## Direction contract

THESIS: Gitr is a ledger of repositories. State is read down aligned columns of numerals and small marks, not from chips, cards or pills. It refuses the SaaS dashboard: no card grid, no bordered-button toolbar, no badge confetti.

OWN-WORLD: Cool graphite neutrals (hue ~285, near-zero chroma) in light and dark; flat surfaces split by 1px hairlines; one violet accent for selection, focus and the single primary action per view. State hues do jobs only: amber changes, sky behind/incoming, green ahead/outgoing, red errors and conflicts. IBM Plex Sans for UI, JetBrains Mono for branches, diff paths, SHAs, code and the commit message (mono keeps the 50/72 line discipline visible); file-list folders stay in the sans for density. 4px control radius, 8px overlays; shadow only on overlays.

STORY: Open the app, read which repos need attention in the top band, fix or open them; in a repo, stage, read the diff, write the message, commit, push; browse history without metadata shouting over subjects.

FIRST VIEWPORT: Sidebar (groups and repos, marks and counts) left. Dashboard: 44px title bar with batch progress and Fetch all / Pull all (the tally lives in the status bar, once); a filter strip with search and count-labelled filter tabs; a dense 30px-row table with a "Needs attention" band above "Everything else"; status bar tally at the bottom.

FORM: Pinned by brief, no seed key. User's words: "Aim for a native Windows developer tool with the finish of a high-quality modern desktop application"; "Prefer a restrained neutral palette, strong typographic hierarchy, subtle separators, deliberate spacing, clear semantic status colors, and one restrained accent color." Signature move: the divergence column, behind bars growing left and ahead bars growing right from a shared axis in every repo row.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
