import type { Group } from '../types'

/**
 * Group colours: six hues that no state uses (amber, sky, green and red mean changes, behind,
 * ahead and trouble; violet means selection). Each is a `--g-<name>` token in index.css.
 */
export const GROUP_COLORS = ['teal', 'rose', 'ochre', 'slate', 'olive', 'plum'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

const known = (c: string | null | undefined): c is GroupColor => GROUP_COLORS.includes(c as GroupColor)

/**
 * Every group's colour: its own if it has one, else the first colour no earlier group has, in
 * order. Once all six are taken, colours repeat.
 */
export function groupColors(groups: Group[]): Map<string, GroupColor> {
  const taken = new Set(groups.map((g) => g.color).filter(known))
  const out = new Map<string, GroupColor>()
  groups.forEach((g, i) => {
    let c: GroupColor | undefined = known(g.color) ? g.color : GROUP_COLORS.find((x) => !taken.has(x))
    c ??= GROUP_COLORS[i % GROUP_COLORS.length]
    taken.add(c)
    out.set(g.id, c)
  })
  return out
}

/** The colour a new group gets: the first one no group has. */
export const nextGroupColor = (groups: Group[]): GroupColor => groupColors([...groups, { id: '\0new', name: '', roots: [] }]).get('\0new')!

/** The CSS value for a group colour. */
export const groupColorVar = (c: GroupColor | undefined) => (c ? `var(--g-${c})` : undefined)

/** Sets `--group`, which the group stripe and swatch draw in. */
export const groupStyle = (c: GroupColor | undefined) => ({ '--group': groupColorVar(c) }) as React.CSSProperties
