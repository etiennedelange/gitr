---
name: Gitr
description: Cobalt. A ruled sheet on a cool base for the Windows desktop. Calm, readable, one cobalt accent.
colors:
  accent: "#1961d4"
  accent-hover: "#0d50c3"
  accent-text: "#0d4cb7"
  accent-ink: "#ffffff"
  selection: "#e0eeff"
  selection-ink: "#072c73"
  sheet: "#f9fbfe"
  rail: "#ebeff4"
  panel: "#f0f4f8"
  raised: "#ffffff"
  line: "#dbe0e6"
  line-soft: "#e6eaee"
  line-strong: "#c5cbd2"
  line-edge: "#7f8793"
  ink: "#111825"
  ink-2: "#414853"
  ink-3: "#5d646e"
  amber: "#df911a"
  amber-ink: "#905211"
  amber-soft: "#fef0d8"
  cyan: "#1794b5"
  cyan-ink: "#006581"
  green: "#359658"
  green-ink: "#22683b"
  red: "#cc3430"
  red-ink: "#a92321"
  red-soft: "#ffece9"
  red-on: "#ffffff"
  add-bg: "#e9f7ee"
  del-bg: "#fdeeec"
  accent-dark: "#6d9df5"
  accent-text-dark: "#9bbeff"
  selection-dark: "#263a5f"
  sheet-dark: "#1f232a"
  rail-dark: "#1a1e25"
  panel-dark: "#23282f"
  raised-dark: "#292e37"
  line-dark: "#333840"
  ink-dark: "#e7ecf0"
  ink-2-dark: "#b8bec7"
  ink-3-dark: "#9aa2ad"
typography:
  headline:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans Fallback, Segoe UI, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans Fallback, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans Fallback, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  label:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans Fallback, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  caption:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans Fallback, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono Fallback, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  sheet: "10px"
spacing:
  s1: "2px"
  s2: "4px"
  s3: "6px"
  s4: "8px"
  s5: "12px"
  s6: "16px"
  s7: "24px"
  s8: "32px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    border: "1px {colors.line-strong}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    border: "1px {colors.accent}"
    rounded: "{rounded.md}"
    height: "32px"
  button-quiet:
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "32px"
  button-icon:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    size: "32px"
  button-small:
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  input:
    backgroundColor: "{colors.raised}"
    border: "1px {colors.line-strong}; {colors.line-edge} on hover"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "32px"
  segmented:
    backgroundColor: "sunken panel"
    height: "24px per segment"
    rounded: "{rounded.md}"
  filter-tab-on:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.selection-ink}"
    typography: "{typography.label}"
  nav-item-active:
    backgroundColor: "{colors.raised}"
    indicator: "3x16px {colors.accent} bar at the start"
    height: "32px"
  ledger-row:
    height: "34px"
    padding: "0 8px 0 24px"
  card:
    backgroundColor: "{colors.raised}"
    border: "1px {colors.line}"
    rounded: "{rounded.lg}"
    shadow: "shadow-card"
  sheet:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.sheet}"
    inset: "8px from the window edge"
    shadow: "shadow-sheet"
  menu:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
    padding: "4px"
---

# Design System: Gitr (Cobalt)

## Overview

**Creative North Star: "A ruled sheet on a cool base"**

The window's base is a cool blue-grey. The sidebar sits directly on it. Every view (Dashboard, a repository, Settings) is one sheet laid over the base, 8px in from the window edge, with a 10px radius, a hairline and a soft edge, like a Windows 11 content layer. Inside the sheet the work is flat and ruled: state is read down aligned columns of numerals and small marks, never from filled chips.

The system is calm and readable rather than dense: 32px controls as in WinUI, 34px ledger rows, a 52px title bar and room between groups. One cobalt accent marks selection, focus and the single primary action of a view. Amber, cyan, green and red only ever mean changes, behind, ahead and trouble. It follows Windows desktop conventions: buttons and fields in an even hairline, a short accent bar on the open item as in a WinUI navigation pane, F6-style focus rings, light and dark themes that follow the OS.

The system was set by a Hallmark redesign (theme Cobalt, app-screen scope) in October 2026. It replaced the earlier flat "ledger" look with its violet accent and per-group colours.

**Key characteristics:**
- The base and the sheet: the only large surfaces. Depth comes from the sheet over the base, then cards and keys on the sheet.
- Tabular numerals everywhere; counts and status words in state ink, never in filled chips.
- One cobalt accent: selection, focus, the open item's bar, one primary button per view.
- IBM Plex Sans for interface, JetBrains Mono for branches, paths, SHAs, diffs and the commit message, both bundled with the app.
- The divergence column: behind bars grow left and ahead bars grow right from a shared axis.
- Groups have no colours. A group is told apart by its heading and the space above it.

## Colors

Cool neutrals tilted toward hue 255 (blue-grey), one cobalt accent and four state hues that each do one job. Every colour has a light and a dark value; the dark theme is the same roles in graphite steps, not a different palette. Every text colour clears WCAG AA (4.5:1) on every surface it sits on, and every mark clears 3:1; `ui/src/themeContrast.test.ts` enforces it.

### Accent
- **Cobalt** (`--accent`; dark `#6d9df5`): selected filter tab count, the open item's bar in the sidebar and the ledger's cursor bar, the active tab underline, the HEAD commit mark, focus rings, the brand mark, and the fill of the one primary button per view (Commit). `--accent-text` is the variant for cobalt text on the sheet.
- **Selection** (`--sel` with `--sel-ink`): background and ink of the selected row, filter tab, file and commit, and the cursor card's wash. Selection is a tint plus the short bar, never a solid accent fill.

### State hues
- **Changes amber** (`--amber` / `--amber-ink` / `--amber-soft`): uncommitted changes, modified files, tag refs, the sign-in and Git banners.
- **Behind cyan** (`--blue` / `--blue-ink`, valued cyan): incoming commits, the behind bar, renamed files, the Pull button. It is cyan rather than blue so it never reads as the cobalt selection.
- **Ahead green** (`--green` / `--green-ink`): outgoing commits, the ahead bar, added files, unpushed commit marks, the Push button, success toasts.
- **Trouble red** (`--red` / `--red-ink` / `--red-soft` / `--red-on`): errors, conflicts, failed operations, deletions. The solid red shapes (the sidebar alert count, the conflict letter tile) set their text in `--red-on`.

Each hue has a plain value for marks and bars, an `-ink` value for text at body size and a `-soft` wash for full-width strips. Diff lines use their own add/del washes. Syntax colours in diffs avoid green and red, which mean added and removed there.

### Neutrals
- **Rail** (`--rail`): the window's base, behind the sidebar and around the sheet.
- **Sheet** (`--bg`): the surface every view sits on.
- **Panel** (`--panel`): table and list heads, the commit box, banners in progress, inline code; one step off the sheet.
- **Raised** (`--raised`): button faces, fields, cards, the open sidebar item, menus and dialogs.
- **Hairlines**: `--line` between regions, `--line-soft` between rows, `--line-strong` for control borders, the divergence axis and the history branch line, `--line-edge` for a hovered field's border and a key cap's lower edge.
- **Ink** (`--ink`, `--ink-2`, `--ink-3`): primary text, secondary text (branch names, list heads), tertiary text (paths, counts, metadata, placeholders).
- Hover and press are translucent ink overlays (about 4.5% and 8.5%) so they work on any surface.

### Named rules
**The One Signal Rule.** Cobalt marks selection, focus, the open item and at most one primary button per view. Everything else that wants emphasis uses weight or state ink.

**The Hue Has A Job Rule.** Amber is changes, cyan is behind, green is ahead, red is error or conflict. A state hue is never decoration, and colour never stands alone: a count, letter or word always sits beside it.

**No Group Colours.** Workspace groups have no colour, swatch or stripe anywhere (sidebar, ledger, cards, Settings). A group reads by its name: its heading in the sidebar, its band in the ledger, and on a card that sits outside its group's band, the group's name in text.

## Typography

**Body font:** IBM Plex Sans Variable (bundled; metric-matched Arial fallback, then Segoe UI).
**Mono font:** JetBrains Mono Variable (bundled; metric-matched Courier New fallback, then Consolas).

Both are the personal brand's faces, bundled so every machine shows the same type and nothing shifts when they load. The scale is about 1.13: 12, 13, 14, 15, 18px, with tabular numerals on the root.

### Hierarchy
- **Headline** (600, 18px): view titles in the title bar, dialog titles.
- **Title** (600, 15px): settings section headings, the brand name, repo names on cards.
- **Body** (400, 14px, 1.45): everything by default. Repo names in the ledger are 600; file names and commit subjects 500.
- **Label** (600, 13px): band and group headings, count numerals, divergence numbers, filter tabs, small buttons. Status words are 13px 500.
- **Caption** (500, 12px): column heads, the status bar, commit metadata. Sentence case, untracked.
- **Mono** (400, 13px): diff body, the commit message box, branch cells, SHAs, file status letters (700, 12px).

### Named rules
**The Tabular Rule.** `font-variant-numeric: tabular-nums` is set on the root. Numbers line up down every column; never turn it off.

**The Sentence Case Rule.** Headings, bands, column heads and labels are sentence case and untracked. Hierarchy comes from weight, size and ink, never from uppercase or letter-spacing.

## Layout

A two-column window: a 248px sidebar on the base, and the sheet. The sheet stacks a 52px title bar, an optional banner or 48px filter strip, the content, and a 28px status bar, each split by a hairline. Spacing steps are 2, 4, 6, 8, 12, 16, 24 and 32px; title bars, strips and the ledger pad 24px on the left.

The ledger is one CSS grid shared by the head and every row, so columns line up: mark, repository, branch, divergence (112px), changes (60px), status, row tools (88px). Rows are 34px with a 32px column head; bands are 40px. The repo view splits into a file list column (about 37% of the sheet, 290 to 420px) and the diff, with the commit box at the foot of the lists. Pane boundaries are splitters: an 8px grab area over the hairline, which turns cobalt on hover, drag or focus; arrow keys move it 16px, Enter or a double-click resets it, and dragged sizes are remembered. Changed files show as a folder tree by default or as a flat list; a two-icon segmented control in the list's head switches, and the choice is remembered.

The dashboard shows compact cards by default. A Table / Cards / Details switch in the filter strip (icon and word; icons only below 980px) changes between the ledger, compact cards and detailed cards, and the choice is remembered.

Responsive steps: below 980px of dashboard width the row tools go and the columns tighten; below 1100px window width the sidebar collapses to a strip of marks and icons (names move to tooltips and screen readers, Ctrl+P finds a repo); below 720px height the file lists shrink to their headers before the commit box leaves. Minimum window is 900x600.

## Elevation & Depth

Three levels, each with its own shadow token, and nothing else casts a shadow:

1. **The sheet** (`--shadow-sheet`): a hairline ring and a soft edge where the sheet meets the base.
2. **Cards and the open sidebar item** (`--shadow-card`, `--shadow-card-hover` on hover): a faint lift off the sheet or the base.
3. **Floating surfaces** (`--shadow-float`): menus, dialogs, the Ctrl+P switcher and toasts. Dialogs dim the window with `--backdrop`.

Buttons and fields are flat with an even hairline. A darker lower edge read as a thick underline in light and, in dark, as a missing bottom border, so neither has one. Rows, panes, the ledger, the diff and the sidebar are flat and ruled.

## Shapes

Small, even corners. Controls and fields use 6px; list rows, menu items, ref labels, inline code and key caps 4px; cards, menus, dialogs, toasts and the switcher 8px; the sheet 10px. Rows and panes inside the sheet are square and divided by hairlines. Status marks are 8px circles (filled, hollow ring, half-filled or haloed); divergence bars are 8px tall with rounding on the outer end only. The open item's bar is 3x16px with 2px rounding. The sidebar alert count is the one fully rounded shape.

## Components

### Buttons
Windows command buttons: a raised face on an even hairline.
- **Shape:** 6px radius, 32px tall, 12px side padding, weight 500, 6px gap to a 16px icon (stroke 1.75).
- **Standard:** raised face on an even `--line-strong` hairline; hover mixes 4% ink into the face, press 8%.
- **Primary:** cobalt fill, white ink (dark theme: dark ink on light cobalt), weight 600. One per view. The commit button splits into Commit and a Push segment. Disabled it turns to a flat panel face.
- **Quiet:** no face until hovered; title bar and inline actions.
- **Next:** a quiet button in the state's ink and weight 600, for what the repo is waiting for (Pull in cyan when behind, Push in green when ahead). It never competes with the primary.
- **Icon:** 32px square, quiet, ink-2, labelled by aria-label and a tooltip. Row and card tools are 26x24.
- **Small:** 28px tall, 8px padding, 13px text. **Danger:** red ink only, never a red fill.
- **Disabled:** a flat face, ink-3 and a not-allowed cursor.
- **Focus:** 2px cobalt outline, 1px offset. Lists and panes draw it 2px inside their edge.

### Fields
Raised box on an even `--line-strong` hairline that darkens to `--line-edge` on hover, 6px radius, 32px tall (28px in filter strips, 13px text). Focus adds a 2px cobalt ring. Search fields carry a 14px icon inside on the left and a clear button on the right. The commit message is mono 13px, line-height 1.55, at least 92px tall, resizable.

### Filter tabs and segmented controls
- **Filter tabs:** quiet buttons in ink-2, each followed by its count in ink-3. The selected tab takes the selection wash with its count in accent text; an alert count turns red ink at 600.
- **Segmented control:** keys on a sunken tray (the panel tone with a faint inner shadow); the chosen segment is raised with a hairline ring and a small shadow.

### View tabs
Text tabs in ink-2; the selected tab turns ink and 600 with a 2px cobalt underline on the hairline below.

### Navigation (sidebar)
On the base, not on the sheet. The brand at the top: the Lucide `git-pull-request` icon in cobalt, 18px, beside "Gitr" in 15px 600. Then Dashboard (with the red attention count), a repo filter, the groups of repos, and Settings with the theme toggle at the foot. Items have no face until hovered; the open one rises to a raised face with the card shadow, weight 600 and the 3x16px cobalt bar at its start. Group heads are 13px 600 ink-2 with a chevron and a count, 16px above each group. Each repo row carries its status mark and its counts in two fixed slots, so numerals align down the list.

### State marks and counts (signature)
- **Status mark:** one 8px mark per repo: filled in the state hue for changes, behind or ahead; a hollow ink-3 ring when clean; a red ring for an error; a solid red dot with a soft halo for conflicts; a half-filled ring while a merge or rebase waits.
- **Counts:** coloured numerals with notation and no fill (`±n` changes in amber ink, `↓n` behind in cyan ink, `↑n` ahead in green ink), 13px 600. Screen readers get the words.
- **Status words:** plain 13px text in the state's ink ("Merging · 1 conflict", "No upstream"). Never a filled pill.
- **File status letters:** git's letter in mono 700 in the state's ink. A conflict is the one solid red tile.

### Divergence column (signature)
Behind and ahead on one axis in every ledger row and on compact cards. A `--line-strong` vertical axis; behind commits draw a cyan bar growing left with its number outside, ahead commits a green bar growing right. Bar length is linear for 1 to 4 commits, then logarithmic to a 40px cap. A repo with no upstream draws nothing.

### Ledger rows
34px grid rows split by `--line-soft`. Hover is the ink overlay; the keyboard cursor row takes the selection wash and the 3x16px cobalt bar at its left edge, with a 1px inset cobalt ring when the table has focus. Row tools appear on hover or for the cursor row. Bands are 13px 600 headings with a count, ruled below: "Needs attention" above "Everything else", or, sorted by status with several groups showing, above one band per group.

### Dashboard cards
Raised cards with a `--line` hairline, 8px radius and the card shadow, in a grid (`auto-fill`, at least 260px compact, 400px detailed, 12px gaps) under the same bands as the ledger. Hover lifts the shadow; the cursor card takes a cobalt border and a light selection wash. A card's VS Code, terminal and More buttons appear on hover or for the cursor card; Pull and Push always show. A card outside its group's band names the group in text.
- **Compact:** mark, name and counts on one line; the branch in mono; the divergence axis and the status word; Pull or Push in the foot.
- **Detailed:** adds the remote host and the upstream; changes, behind and ahead as three numerals (– when zero); a 4px bar splitting conflicted, staged and unstaged files; the HEAD commit's short SHA, subject and age; an error as a red-soft strip; the status word in the foot.
- **New changes:** when a count goes up or trouble starts, the card washes in that state's soft hue and fades over 1.6s, once per change. A 6px dot in the state hue stays beside the counts until the card is hovered, focused or opened. Under reduced motion only the dot shows.

### History rows
Two-line 44px rows. A 1.5px `--line-strong` branch line runs through 8px commit marks: ink-3 by default, cobalt and 10px for HEAD, a green ring for unpushed, a ringed target for merges. The second line (author, SHA, date) is 12px ink-3. Ref labels are quiet 18px outlines; the checked-out branch is in accent ink, tags in amber, remotes dashed.

### Menus, dialogs, toasts
Raised overlay, 1px `--line` border, 8px radius, float shadow. Menus open below their trigger with a short slide and fade; items take the selection wash on hover or focus. Toasts sit above the status bar at the bottom right, rise in over 180ms, and lead with a green or red icon. Dialogs sit over `--backdrop`.

### Banners
Full-width strips under the title bar, a 16px icon on the left, a bold message, muted detail, actions on the right. Amber wash for sign-in and Git problems, panel for an operation in progress, red wash for conflicts and errors, cobalt wash for news about Gitr itself (an update), so it never reads as "behind".

### Settings
Nav (168px) and content (up to 720px) centred on the sheet; the whole sheet scrolls, and the nav sticks. Each section is a title (15px 600), an optional line on what it is for, and one raised list (`--line` border, 8px radius, no shadow) of setting rows ruled by `--line` (the dark soft hairline vanishes on the raised face). A row is at least 56px: name (500, ink) with a 13px ink-3 hint under it on the left, the control right-aligned. Number fields are 72px and right-aligned, text fields and selects 260px. On/off settings are WinUI toggle switches (40x20, cobalt track when on); the theme is a segmented control. Workspace groups are blocks in the list: the name field, the repo count in ink-3, then Add folder and Remove group; folders below in mono with a folder icon. Shortcuts are grouped by where they work, each key a cap. "Unsaved changes" shows in amber ink beside Revert and Save.

### Diff
Mono 13px at line-height 1.6 in a table. Added lines on a green wash and removed on a red wash, with stronger tints in the line-number gutter. Hunk headers are 12px sans on the hunk panel.

## Motion

Quick and ease-out: 100ms for state changes, 160ms for menus and tabs, on `cubic-bezier(0.16, 1, 0.3, 1)`. Only transform, opacity, colour and shadow animate. One authored moment: the card flash for new changes. Under `prefers-reduced-motion` every animation and transition collapses to 1ms.

## Do's and Don'ts

### Do:
- **Do** set state in columns of tabular numerals and 8px marks, with words for screen readers.
- **Do** keep cobalt to selection, focus, the open item's bar and one primary button per view (Commit in the repo view).
- **Do** use the `-ink` variant of a state hue for text and the plain hue for marks and bars.
- **Do** put branches, paths, SHAs, code and commit messages in JetBrains Mono 13px.
- **Do** keep views on the sheet and the sidebar on the base; divide regions and rows inside the sheet with hairlines.
- **Do** keep shadows to the three levels: the sheet, cards and the open item, floating surfaces.
- **Do** keep motion quick and ease-out, and collapse it under reduced motion.

### Don't:
- **Don't** give workspace groups a colour, stripe or swatch; a group reads by its name.
- **Don't** build filled status chips or badge confetti, or use a state hue as decoration.
- **Don't** show a colour without a count, letter or word beside it.
- **Don't** set headings, labels or column heads in uppercase or with letter-spacing.
- **Don't** add a second accent colour or a second primary button to a view, or use blue for anything but cobalt's jobs (behind is cyan).
- **Don't** add shadows to rows, panes or the sidebar; only the sheet, cards and floating surfaces have depth.
