import { useEffect, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/** A file-list row's height in px: the stylesheet's `--row`. */
export const FILE_ROW_H = 28
/** The list's own padding in px (`--s2`): above the first row (a list may have none) and below the last. */
const PAD = 4

/** A list this short is drawn whole; a longer one draws only the rows in view. */
export const FILE_LIST_VIRTUAL_MIN = 200

/** The part of a long list to draw. */
export interface RowWindow {
  /** The rows to draw are `rows.slice(from, to)`. */
  from: number
  to: number
  /** The room, in px, of the rows before and after them. */
  before: number
  after: number
}

/**
 * Draws only the rows of a long, fixed-height list that are in view (plus a margin). `list` is the
 * scrolling element, `active` the index of the row to keep in view (-1 for none): a key press moves
 * the selection, and the list follows it. `padTop` is the list's padding above its first row.
 */
export function useRowWindow(count: number, list: RefObject<HTMLElement | null>, active: number, padTop = PAD): RowWindow {
  const virtual = count > FILE_LIST_VIRTUAL_MIN
  const rows = useVirtualizer({
    count,
    getScrollElement: () => list.current,
    estimateSize: () => FILE_ROW_H,
    overscan: 20,
    // The rows sit inside the list's padding, so they are measured from the edge of it.
    paddingStart: padTop,
    paddingEnd: PAD,
    // The first screen of rows is drawn at once, before the list has been measured.
    initialRect: { width: 0, height: 1200 },
    enabled: virtual,
  })
  useEffect(() => {
    if (virtual && active >= 0) rows.scrollToIndex(active, { align: 'auto' })
    // Only a move of the selection scrolls; scrolling by hand must not snap back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual, active])

  if (!virtual) return { from: 0, to: count, before: 0, after: 0 }
  const shown = rows.getVirtualItems()
  return {
    from: shown[0]?.index ?? 0,
    to: (shown.at(-1)?.index ?? -1) + 1,
    before: shown[0] ? shown[0].start - padTop : 0,
    after: shown.length ? rows.getTotalSize() - PAD - shown.at(-1)!.end : 0,
  }
}

/**
 * Stands in for the rows of a long list that aren't drawn. It is only room: hidden from screen
 * readers, so the list's rows are all the list has.
 */
export function RowGap({ height }: { height: number }) {
  return height > 0 ? <li className="row-gap" aria-hidden="true" style={{ height }} /> : null
}
