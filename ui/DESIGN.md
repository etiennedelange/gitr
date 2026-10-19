---
name: Gitr
description: A ledger of Git repositories for the Windows desktop. Dense, flat, cool graphite, one violet accent.
colors:
  accent: "#6145d4"
  accent-hover: "#5236c4"
  accent-text: "#5236c4"
  accent-ink: "#ffffff"
  selection: "#ebe7fc"
  selection-ink: "#2b1d74"
  window: "#fcfcfd"
  rail: "#f3f3f6"
  panel: "#f6f6f8"
  raised: "#ffffff"
  line: "#e3e3e8"
  line-soft: "#ececf0"
  line-strong: "#cfcfd7"
  ink: "#1b1b20"
  ink-2: "#5a5a66"
  ink-3: "#6b6b77"
  amber: "#d48a1c"
  amber-ink: "#8b4f00"
  amber-soft: "#fbf0dc"
  sky: "#2f84d6"
  sky-ink: "#1b60a6"
  green: "#2c9a5e"
  green-ink: "#1c7244"
  red: "#d2402f"
  red-ink: "#ab2a1c"
  red-soft: "#fdece9"
  red-on: "#ffffff"
  group-teal: "#13858a"
  group-rose: "#c23f7d"
  group-ochre: "#9a6a2c"
  group-slate: "#5c6c88"
  group-olive: "#6f7d1c"
  group-plum: "#8a4fa0"
  add-bg: "#ebf7ef"
  del-bg: "#fdeeeb"
  accent-dark: "#9a88ff"
  accent-text-dark: "#b4a7ff"
  selection-dark: "#2c2747"
  window-dark: "#19191c"
  rail-dark: "#141417"
  panel-dark: "#1e1e22"
  raised-dark: "#25252a"
  line-dark: "#2b2b31"
  ink-dark: "#ebebef"
  ink-2-dark: "#a4a4ae"
typography:
  headline:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans Fallback, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.008em"
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
  band:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans Fallback, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.02em"
  mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono Fallback, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "4px"
  md: "5px"
  lg: "8px"
spacing:
  s1: "2px"
  s2: "4px"
  s3: "6px"
  s4: "8px"
  s5: "12px"
  s6: "16px"
  s7: "24px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-quiet:
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-icon:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    size: "28px"
  button-small:
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  input:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  filter-tab-on:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.selection-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "26px"
  nav-item-active:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.selection-ink}"
    rounded: "{rounded.md}"
    height: "28px"
  list-row:
    rounded: "{rounded.sm}"
    height: "26px"
  ledger-row:
    height: "30px"
    padding: "0 8px 0 16px"
  commit-row:
    rounded: "{rounded.sm}"
    height: "44px"
  menu:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
    padding: "4px"
  ref-label:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    height: "18px"
    padding: "0 5px"
---

# Design System: Gitr

## Overview

**Creative North Star: "The Ledger"**

Gitr reads like a ledger of repositories. State is read down aligned columns of tabular numerals and small marks, not from cards, chips or pills. The window is one flat surface on cool graphite neutrals (hue near 285, almost no chroma), split by 1px hairlines into a tinted sidebar, a 44px title bar, a filter strip, a dense table and a status bar.

The system is dense and quiet. Body text is 14px, rows are 26 to 30px, controls are 28px. One violet accent marks selection, focus and the single primary action of a view. Amber, sky, green and red only ever mean changes, behind, ahead and trouble. It follows Windows desktop conventions: raised command buttons with a hairline, F6-style focus rings, Explorer-like lists, light and dark themes that follow the OS.

**Key Characteristics:**
- Flat surfaces, hairline separators, no shadow except on things that float.
- Tabular numerals everywhere; counts and status words in state ink, never in filled chips.
- One violet accent, used for selection, focus and one primary button per view.
- IBM Plex Sans for interface, JetBrains Mono for branches, paths, SHAs, diffs and the commit message, both bundled with the app.
- The divergence column: behind bars grow left and ahead bars grow right from a shared axis.

## Colors

Cool graphite neutrals, one violet accent and four state hues that each do one job. Every color has a light and a dark value; the dark theme is the same roles, not a different palette.

### Primary
- **Ledger Violet** (accent; dark: accent-dark): selected filter tab count, active tab underline, the HEAD commit mark, focus rings, and the fill of the one primary button per view (Commit). `accent-text` is the darker or lighter variant for violet text on the window.
- **Violet Wash** (selection, with selection-ink): background and ink of the selected row, nav item, filter tab, file and commit. Selection is a tint, never a solid accent bar.

### Secondary (state hues)
- **Changes Amber** (amber / amber-ink / amber-soft): uncommitted changes, modified files, tag refs, and the sign-in and Git banners.
- **Behind Sky** (sky / sky-ink): incoming commits, the behind bar, renamed files, the Pull "next" button.
- **Ahead Green** (green / green-ink): outgoing commits, the ahead bar, added files, unpushed commit marks, the Push "next" button, success toasts.
- **Trouble Red** (red / red-ink / red-soft / red-on): errors, conflicts, failed operations, deletions. The two solid red shapes (the sidebar alert count and the conflict letter tile) set their text in `red-on`: white in light, near-black in dark, where white on the lighter red is only about 3:1.

Each hue has a plain value for marks and bars, an `-ink` value for text at body size, and a `-soft` wash for full-width strips. Diff lines use their own add/del washes (add-bg, del-bg, plus line-number tints in the sidecar).

### Group colours
- **Teal, Rose, Ochre, Slate, Olive, Plum** (`--g-*`, each with a lighter dark-theme value): one per workspace group, chosen in Settings or given the next unused one. They are hues no state uses, so a group never reads as changes, behind, ahead or trouble. Shown only when there is more than one group, as a 3px stripe down the left edge of the group's rows (sidebar and ledger) and an 8px square swatch beside the group's name (sidebar heading, ledger band).

### Neutral
- **Window** (window): the work area.
- **Rail** (rail): the sidebar column, slightly darker than the window.
- **Panel** (panel): table head, status bar, commit box, inline code; one step off the window.
- **Raised** (raised): button faces, fields, menus and dialogs.
- **Hairlines** (line, line-soft, line-strong): `line` between regions, `line-soft` between rows, `line-strong` for control borders, the divergence axis and the history branch line.
- **Ink** (ink, ink-2, ink-3): primary text, secondary text (branch names, headings of lists), tertiary text (paths, counts, metadata).
- Hover and press are translucent ink overlays (4.5% and 8%) so they work on any surface.

### Named Rules
**The One Voice Rule.** Violet marks selection, focus and at most one primary button per view. Everything else that wants emphasis uses weight or state ink.

**The Hue Has A Job Rule.** Amber is changes, sky is behind/incoming, green is ahead/outgoing, red is error or conflict. A state hue is never decoration, and color never stands alone: a count, letter or word always sits beside it. Group colours name a group and nothing else: the group's name always heads the rows that carry its stripe, as the sidebar heading and, with all groups showing, the ledger band.

## Typography

**Body Font:** IBM Plex Sans Variable (bundled; metric-matched Arial fallback, then Segoe UI)
**Mono Font:** JetBrains Mono Variable (bundled; metric-matched Courier New fallback, then Consolas)

Both are the personal brand's defaults (`design/brand.md`), bundled so every machine shows the same type; Windows 10 has no Cascadia Mono.

**Character:** A plain grotesk at small sizes with weights between 400 and 600, tabular numerals on by default. Mono marks anything that is git's own text: branch names, diff paths, SHAs, code, the commit message (so the 50/72 line discipline stays visible). File-list folder paths stay in the grotesk for density.

### Hierarchy
- **Headline** (600, 17px, 1.2): view titles in the 44px title bar, dialog titles.
- **Title** (600, 15px, 1.3): settings section headings, brand name.
- **Body** (400, 14px, 1.45): everything by default. Repo names in the ledger are 600; sidebar repo names 450; file names and commit subjects 500.
- **Label** (600, 13px): count numerals, divergence numbers, status words (500), filter tabs, small buttons, section heads in lists.
- **Band** (600, 12px, 0.02em tracking, sentence case): ledger band headings ("Needs attention", "Everything else"), sidebar group names, table column heads (600), status bar, commit metadata line.
- **Mono** (400, 13px): diff body (line-height 1.6), commit message box (1.55), branch cells, SHAs, file status letters (700, 12px).

### Named Rules
**The Tabular Rule.** `font-variant-numeric: tabular-nums` is set on the root. Numbers line up down every column; never turn it off.

**The Sentence Case Rule.** Headings, bands and labels are sentence case at 12 to 17px. Hierarchy comes from weight and ink, not uppercase or tracking.

## Layout

A two-column window: a 240px sidebar and a flexible main column. The main column stacks a 44px title bar, an optional 40px banner or filter strip, the content, and a 26px status bar, each split by a 1px hairline. Spacing steps are 2, 4, 6, 8, 12, 16, 24px; title bars and strips pad 16px left and 12px right.

The dashboard ledger is one CSS grid shared by the head and every row, so columns line up: mark (16px), repository, branch, divergence (112px), changes (60px), status, row tools (88px). Rows are 30px, band headings 28px. Sidebar and file-list rows are 26px; history rows are 44px with two lines. The repo view splits into a file list column (37% of the main column, 290 to 420px) and a diff, with the commit box pinned at the foot of the lists. Pane boundaries are splitters: the sidebar's edge, the file list's edge, the line between Unstaged and Staged, the commit list's edge in History and the foot of a commit's file list. Each is an 8px grab area over the hairline, which turns violet on hover, drag or focus; arrow keys move it 16px, Enter or a double-click resets it. Dragged sizes are remembered. Changed files show as a folder tree by default (chevron and folder name, chains of single folders on one row, 16px indent per level), or as a flat list with each file's folder beside it; a two-icon segmented control in the list's head switches, and the choice is remembered.

Responsive steps: below 980px of dashboard width the row tools go and the columns tighten; below 1100px window width the sidebar collapses to a 48px strip of marks and icons (names move to screen readers, Ctrl+P finds a repo); below 720px height the file lists shrink to their headers before the commit box leaves; below 760px the title bar wraps. Minimum window is 900x600.

## Elevation & Depth

Flat. Depth comes from tone (rail darker than window, panel one step off) and hairlines. The only shadow is for surfaces that float above the window: menus, dialogs, the Ctrl+P switcher and toasts.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 10px 28px -6px rgb(0 0 0 / 0.22)`): menus, dialogs, switcher, toasts. Always paired with a 1px `line` border and the 8px radius.

### Named Rules
**The Only Floaters Cast Shadows Rule.** If it sits in the window's flow (sidebar, table, panes, cards in settings), it has no shadow. If it floats over the window, it gets the float shadow and nothing stronger.

## Shapes

Small, even corners. Controls and the settings card use 5px; list rows, menu items, ref labels, inline code and key caps use 4px; menus, dialogs, toasts and the switcher use 8px. Regions and table rows are square and divided by hairlines. Status marks are 8px circles (filled, hollow ring, half-filled, or haloed); divergence bars are 8px tall with 3px rounding on the outer end only. The sidebar alert count is the one fully rounded shape.

## Components

### Buttons
Windows command buttons: quiet, compact, with a hairline.
- **Shape:** 5px radius, 28px tall, 12px side padding, weight 500, 6px gap to a 15px icon (stroke 1.75).
- **Standard:** raised face with a `line-strong` hairline; hover mixes 4% ink into the face, press 8%.
- **Primary:** violet fill, white ink (dark theme: dark ink on light violet), weight 600. One per view. The commit button splits into Commit and a Push segment joined by a tinted seam; disabled it turns to a flat panel face instead of fading.
- **Quiet:** no face until hovered; used in title bars and inline (Fetch all, Pull all).
- **Next:** a quiet button in the state's ink and weight 600, for what the repo is waiting for (Pull when behind, Push when ahead). It never competes with the primary.
- **Icon:** 28px square, quiet, ink-2, labelled by aria-label and tooltip. Row tools use 26x24.
- **Small:** 24px tall, 8px padding, 13px text. **Danger:** red ink only, no red fill.
- **Focus:** 2px violet outline, 1px offset. Lists and panes draw it 2px inside their edge.

### Filter tabs and segmented control
- **Filter tabs:** 26px quiet buttons in ink-2, each followed by its count in ink-3. The selected tab takes the violet wash with its count in accent text; an alert count turns red ink at 600.
- **Segmented control:** a panel track with a hairline; the selected segment is a raised face with a `line-strong` ring.

### View tabs
Text tabs at 34px in ink-2; the selected tab turns ink and 600 and gets a 2px violet underline sitting on the hairline below.

### Inputs / Fields
- **Style:** raised field, `line-strong` hairline, 5px radius, 28px tall (26px in filter strips, 13px text). Search fields carry a 14px icon inside on the left and a clear button on the right.
- **Hover:** border darkens by 18% ink. **Focus:** border and a 1px ring in violet.
- **Commit message:** mono 13px, line-height 1.55, at least 92px tall, resizable.

### Navigation (sidebar)
A tinted column, not a card. Brand mark and name at the top in a 44px bar, Dashboard, a filter field, groups of repos, Settings at the foot. Nav items and repo rows have no face until hovered (rail-hover); the active one takes the violet wash, selection ink and weight 600. Group heads are band type in ink-2 with a chevron and a count. Each repo row carries its status mark and count notation in two fixed slots, so numerals align down the list. With several groups, each group heading carries its swatch and its repos a stripe along the rail's left edge, unbroken down the group.

### State marks and counts (signature)
- **Status mark:** one 8px mark per repo: filled in the state hue for changes, behind or ahead; a hollow ink-3 ring when clean; a red ring for an error; a solid red dot with a soft halo for conflicts; a half-filled ring while a merge or rebase waits.
- **Counts:** colored numerals with notation and no fill (`±n` changes in amber ink, `↓n` behind in sky ink, `↑n` ahead in green ink), 13px 600. Screen readers get the words.
- **Status words:** plain 13px text in the state's ink ("Merging · 1 conflict", "No upstream"). Never a filled pill.
- **File status letters:** git's letter in mono 700 in the state's ink. A conflict is the one solid red tile.

### Divergence column (signature)
Behind and ahead on one axis in every ledger row. A `line-strong` vertical axis runs down the column; behind commits draw a sky bar growing left with its number on the outside, ahead commits a green bar growing right. Bar length is linear for 1 to 4 commits, then logarithmic to a 40px cap. A repo with no upstream draws nothing.

### Ledger rows
30px grid rows split by `line-soft`. Hover is the ink overlay; the keyboard cursor row is the violet wash, with a 1px inset violet ring when the table has focus. Row tools fade in on hover or cursor. Bands are 12px band type with a count, on a hairline: "Needs attention" above "Everything else", or, sorted by status with all of several groups showing, above one band per group led by its swatch. With several groups, each row carries its group's 3px stripe at its left edge.

### History rows
Two-line 44px rows. A `line-strong` branch line runs through 8px commit marks: ink-3 by default, violet and 10px for HEAD, a green ring for unpushed, a ringed target for merges. The second line (author, SHA, date) is 12px ink-3. Ref labels are quiet 18px outlines: HEAD in violet, tags in amber, remotes dashed.

### Menus, dialogs, toasts
Raised overlay, 1px `line` border, 8px radius, float shadow. Menus open 4px below their trigger with a 3px slide and fade (140ms); items are 28px, 4px radius, and take the violet wash on hover or focus. Toasts sit above the status bar bottom right, rise 6px over 180ms, and lead with a green or red icon.

### Banners
Full-width strips under the title bar, 40px minimum, 15px icon on the left, bold message, muted detail, actions on the right. Amber wash for sign-in and Git problems, panel for an operation in progress, red wash for conflicts and errors.

### Diff
Mono 13px at line-height 1.6 in a table. Added lines on a green wash, removed on a red wash, with stronger tints in the line-number gutter. Hunk headers are 12px grotesk on a hunk panel.

## Do's and Don'ts

### Do:
- **Do** set state in columns of tabular numerals and 8px marks, with words for screen readers.
- **Do** keep violet to selection, focus and one primary button per view (Commit in the repo view).
- **Do** use the `-ink` variant of a state hue for text and the plain hue for marks and bars.
- **Do** put branches, paths, SHAs, code and commit messages in JetBrains Mono 13px.
- **Do** divide regions and rows with 1px hairlines (`line` between regions, `line-soft` between rows).
- **Do** give anything that floats the 8px radius, `line` border and float shadow, and nothing else a shadow.
- **Do** keep motion quick and ease-out (90ms state changes, 140ms menus and tabs) and collapse it under reduced motion.

### Don't:
- **Don't** build card grids, bordered-button toolbars or filled status chips; the dashboard is a table.
- **Don't** use a state hue as decoration, or show a color without a count, letter or word beside it.
- **Don't** add shadows to surfaces that sit in the window's flow; the window is flat.
- **Don't** set headings or labels in uppercase or with wide tracking.
- **Don't** add a second accent color or a second primary button to a view.
