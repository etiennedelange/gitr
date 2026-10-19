/** A changed-files tree: folders first, by name, then files in the order given. */
export interface Folder<T> {
  /** The folder's path from the repo root, without a trailing slash. */
  path: string
  /** What the row shows; a chain of single-child folders is one row, `src/components`. */
  name: string
  folders: Folder<T>[]
  files: T[]
}

/** One visible row of a tree, in display order. */
export type TreeRow<T> =
  | { kind: 'folder'; path: string; name: string; depth: number; open: boolean; files: T[] }
  | { kind: 'file'; file: T; depth: number }

const parts = (p: string) => p.split(/[\\/]/)
const byName = (a: string, b: string) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
}

export function buildTree<T extends { path: string }>(files: T[]): Folder<T> {
  const root: Folder<T> = { path: '', name: '', folders: [], files: [] }
  for (const f of files) {
    const segs = parts(f.path)
    let at = root
    for (const seg of segs.slice(0, -1)) {
      const path = at.path ? `${at.path}/${seg}` : seg
      let next = at.folders.find((d) => d.path === path)
      if (!next) {
        next = { path, name: seg, folders: [], files: [] }
        at.folders.push(next)
      }
      at = next
    }
    at.files.push(f)
  }
  const tidy = (d: Folder<T>): Folder<T> => {
    // Fold a folder whose only content is one folder into it: `src` + `components` -> `src/components`.
    while (d.path && !d.files.length && d.folders.length === 1) {
      const only = d.folders[0]
      d = { ...only, name: `${d.name}/${only.name}` }
    }
    return {
      ...d,
      folders: d.folders.map(tidy).sort((a, b) => byName(a.name, b.name)),
      // Files keep the order they came in: git's, with conflicts first in Changes.
      files: d.files,
    }
  }
  return tidy(root)
}

/** Every file under a folder, in display order. */
export function filesOf<T>(d: Folder<T>): T[] {
  return [...d.folders.flatMap(filesOf), ...d.files]
}

/** The rows to show; a folder whose path is in `closed` shows its own row but not its contents. */
export function treeRows<T>(root: Folder<T>, closed: ReadonlySet<string>): TreeRow<T>[] {
  const rows: TreeRow<T>[] = []
  const walk = (d: Folder<T>, depth: number) => {
    for (const sub of d.folders) {
      const open = !closed.has(sub.path)
      rows.push({ kind: 'folder', path: sub.path, name: sub.name, depth, open, files: filesOf(sub) })
      if (open) walk(sub, depth + 1)
    }
    for (const file of d.files) rows.push({ kind: 'file', file, depth })
  }
  walk(root, 0)
  return rows
}

/** The rows of a flat list: every file, in the order given. */
export const listRows = <T>(files: T[]): TreeRow<T>[] => files.map((file) => ({ kind: 'file', file, depth: 0 }))
