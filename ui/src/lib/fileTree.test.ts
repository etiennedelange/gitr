import { describe, expect, it } from 'vite-plus/test'
import { buildTree, filesOf, listRows, treeRows } from './fileTree'

const f = (path: string) => ({ path })
const shape = (rows: ReturnType<typeof treeRows<{ path: string }>>) =>
  rows.map((r) => (r.kind === 'folder' ? `${'  '.repeat(r.depth)}${r.name}/` : `${'  '.repeat(r.depth)}${r.file.path.split('/').pop()}`))

describe('file tree', () => {
  it('lists folders first by name, then files in the order given, and folds single-folder chains', () => {
    const tree = buildTree([f('z.md'), f('ui/src/components/B.tsx'), f('ui/src/components/A.tsx'), f('ui/src/App.tsx'), f('Cargo.toml'), f('docs/a.md')])
    expect(shape(treeRows(tree, new Set()))).toEqual([
      'docs/',
      '  a.md',
      'ui/src/',
      '  components/',
      '    B.tsx',
      '    A.tsx',
      '  App.tsx',
      'z.md',
      'Cargo.toml',
    ])
  })

  it('keys a folded chain by its innermost folder and hides what a closed folder holds', () => {
    const tree = buildTree([f('ui/src/components/A.tsx'), f('ui/src/App.tsx'), f('docs/a.md')])
    const rows = treeRows(tree, new Set(['ui/src']))
    expect(shape(rows)).toEqual(['docs/', '  a.md', 'ui/src/'])
    const ui = rows[2]
    expect(ui).toMatchObject({ kind: 'folder', path: 'ui/src', open: false })
    // A closed folder's row still carries every file under it, for its stage and discard buttons.
    expect(ui.kind === 'folder' && ui.files.map((x) => x.path)).toEqual(['ui/src/components/A.tsx', 'ui/src/App.tsx'])
  })

  it('sorts folders without regard to case and accepts backslashes', () => {
    const tree = buildTree([f('b\\x.ts'), f('A/y.ts'), f('a/z.ts')])
    expect(tree.folders.map((d) => d.name)).toEqual(['A', 'a', 'b'])
    expect(filesOf(tree).map((x) => x.path)).toEqual(['A/y.ts', 'a/z.ts', 'b\\x.ts'])
  })

  it('a list is every file at depth 0, in order', () => {
    expect(listRows([f('b/x'), f('a')])).toEqual([
      { kind: 'file', file: f('b/x'), depth: 0 },
      { kind: 'file', file: f('a'), depth: 0 },
    ])
  })
})
