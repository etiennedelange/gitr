import { describe, expect, it } from 'vite-plus/test'
import css from './index.css?raw'

// WCAG 2.1 contrast of the theme tokens: text 4.5:1 (AA), shapes and icons 3:1.

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const block = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const SURFACES = ['bg', 'rail', 'panel', 'raised', 'field', 'overlay', 'hunk-bg']
const SYNTAX = ['syn-keyword', 'syn-type', 'syn-function', 'syn-string', 'syn-number', 'syn-comment', 'syn-meta']
// [text tokens, the backgrounds they sit on, minimum ratio]
const PAIRS: [string[], string[], number][] = [
  [['ink', 'ink-2', 'ink-3', 'accent-text', 'amber-ink', 'blue-ink', 'green-ink', 'red-ink', 'hunk-ink', ...SYNTAX], SURFACES, 4.5],
  [['ink', 'ink-3', 'add-ink', ...SYNTAX], ['add-bg', 'add-ln'], 4.5],
  [['ink', 'ink-3', 'del-ink', ...SYNTAX], ['del-bg', 'del-ln'], 4.5],
  [['sel-ink', 'ink', 'ink-2'], ['sel'], 4.5],
  [['amber-ink'], ['amber-soft'], 4.5],
  [['blue-ink'], ['blue-soft'], 4.5],
  [['green-ink'], ['green-soft'], 4.5],
  [['red-ink'], ['red-soft'], 4.5],
  [['accent-ink'], ['accent'], 4.5],
  [['red-on'], ['red'], 4.5],
  [
    ['accent', 'focus', 'amber', 'blue', 'green', 'red', 'g-teal', 'g-rose', 'g-ochre', 'g-slate', 'g-olive', 'g-plum'],
    ['bg', 'rail', 'panel', 'raised'],
    3,
  ],
]

describe('dark theme', () => {
  const t = tokens(":root[data-theme='dark']")

  it('meets WCAG AA contrast for every text and shape colour on the surfaces it sits on', () => {
    const failures = PAIRS.flatMap(([fgs, bgs, min]) =>
      fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, ratio: contrast(t[fg], t[bg]), min }))),
    ).filter((p) => !(p.ratio >= p.min))
    expect(failures.map((f) => `${f.fg} on ${f.bg}: ${f.ratio.toFixed(2)} < ${f.min}`)).toEqual([])
  })

  it('keeps large surfaces well off black, for OLED screens', () => {
    for (const s of ['bg', 'rail', 'panel', 'field']) expect(luminance(t[s]), s).toBeGreaterThan(luminance('#1c1c1c'))
  })
})
