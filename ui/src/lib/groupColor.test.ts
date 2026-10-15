import { describe, expect, it } from 'vite-plus/test'
import { groupColors, nextGroupColor } from './groupColor'
import type { Group } from '../types'

const g = (id: string, color?: string | null): Group => ({ id, name: id, roots: [], color })

describe('group colours', () => {
  it('gives groups without a colour the first one no other group has', () => {
    const colors = groupColors([g('a'), g('b', 'teal'), g('c'), g('d', 'nonsense')])
    expect([...colors.values()]).toEqual(['rose', 'teal', 'ochre', 'slate'])
  })

  it('repeats colours once all six are taken', () => {
    const groups = Array.from({ length: 8 }, (_, i) => g(`g${i}`))
    expect([...groupColors(groups).values()]).toEqual(['teal', 'rose', 'ochre', 'slate', 'olive', 'plum', 'teal', 'rose'])
  })

  it('picks the first free colour for a new group', () => {
    expect(nextGroupColor([])).toBe('teal')
    expect(nextGroupColor([g('a'), g('b', 'ochre')])).toBe('rose')
  })
})
