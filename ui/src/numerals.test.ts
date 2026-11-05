import { describe, expect, it } from 'vite-plus/test'
import css from './index.css?raw'

/** Every CSS rule (selector list and body), comments stripped. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  body: m[2],
}))

describe('numerals', () => {
  // The `font:` shorthand resets font-variant-numeric to normal, undoing the root's tabular-nums.
  // Counts and badges that set `font:` must set tabular-nums again, or their digits change width.
  it.each(['.count', '.badge', '.nav-count'])('%s keeps tabular digits after its font shorthand', (sel) => {
    const own = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === sel) && /(^|;|\s)font:/.test(r.body))
    expect(own.length).toBeGreaterThan(0)
    for (const r of own) expect(r.body).toMatch(/font-variant-numeric:\s*tabular-nums/)
  })
})
